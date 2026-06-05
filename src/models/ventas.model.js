'use strict'
const crypto = require('crypto')
const db = require('../config/db')

const VentasModel = {

  // ── Auxiliares ────────────────────────────────────────────────
  listarClientes() {
    return db.prepare(`SELECT id, nombre, apellido, tel_whatsapp FROM clientes WHERE activo = 1 ORDER BY nombre`).all()
  },

  listarProductos() {
    return db.prepare(`
      SELECT p.id, p.nombre, p.unidad_medida, p.precio_referencia,
             (COALESCE(s.cantidad_actual,0) - COALESCE(s.cant_pendiente_entregar,0)) AS disponible_real
      FROM productos p LEFT JOIN stock s ON s.id_producto = p.id
      WHERE p.activo = 1 ORDER BY p.nombre
    `).all()
  },

  contarPorEstado() {
    return db.prepare(`SELECT estado, COUNT(*) AS total FROM op_encabezado WHERE tipo_op IN ('M') GROUP BY estado`).all()
  },

  // ── Listado con paginación, búsqueda y ordenamiento ───────────
  listar({ estado, id_cliente, q, sort, dir, page = 1, limit = 20 } = {}) {
    const wheres = [`op.tipo_op = 'M'`]
    const params = []
    if (estado)     { wheres.push('op.estado = ?');     params.push(estado) }
    if (id_cliente) { wheres.push('op.id_cliente = ?'); params.push(id_cliente) }
    if (q && String(q).trim()) {
      const term = `%${String(q).trim()}%`
      wheres.push(`(c.nombre LIKE ? OR op.observaciones LIKE ? OR CAST(op.nro_op AS TEXT) LIKE ?)`)
      params.push(term, term, term)
    }
    const where = 'WHERE ' + wheres.join(' AND ')

    // Ordenamiento con whitelist (evita inyección por columna)
    const sortMap = {
      nro_op: 'op.nro_op', cliente: 'cliente_nombre', fecha: 'op.fecha_emision',
      total: 'total', estado: 'op.estado',
    }
    const orderCol = sortMap[sort] || 'op.created_at'
    const orderDir = String(dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC'

    const offset = (page - 1) * limit
    const total  = db.prepare(`
      SELECT COUNT(*) AS n FROM op_encabezado op
      LEFT JOIN clientes c ON c.id = op.id_cliente
      ${where}
    `).get(...params).n
    const ops = db.prepare(`
      SELECT op.id, op.nro_op, op.tipo_op, op.estado, op.fecha_emision, op.nro_remito,
             COALESCE(c.nombre, op.observaciones, 'Particular') AS cliente_nombre,
             u.nombre AS administrativo_nombre,
             (SELECT COALESCE(SUM(d.cantidad_pedida * d.precio_unitario),0)
              FROM op_detalle_material d WHERE d.id_orden_pedido = op.id) AS total
      FROM op_encabezado op
      LEFT JOIN clientes c ON c.id = op.id_cliente
      JOIN users    u ON u.id = op.id_administrativo
      ${where} ORDER BY ${orderCol} ${orderDir} LIMIT ? OFFSET ?
    `).all(...params, limit, offset)
    return { ops, total, page, limit, totalPaginas: Math.ceil(total / limit) || 1 }
  },

  obtener(id) {
    const op = db.prepare(`
      SELECT op.*, COALESCE(c.nombre, 'Particular') AS cliente_nombre,
             c.tel_whatsapp, c.domicilio_ppal,
             u.nombre AS administrativo_nombre
      FROM op_encabezado op
      LEFT JOIN clientes c ON c.id = op.id_cliente
      JOIN users    u ON u.id = op.id_administrativo
      WHERE op.id = ?
    `).get(id)
    if (!op) return null
    op.detalles = db.prepare(`
      SELECT d.*, p.nombre AS producto_nombre, p.unidad_medida,
             (d.cantidad_pedida * d.precio_unitario) AS subtotal
      FROM op_detalle_material d JOIN productos p ON p.id = d.id_producto
      WHERE d.id_orden_pedido = ?
    `).all(id)
    op.total = op.detalles.reduce((s, d) => s + d.subtotal, 0)
    return op
  },

  crear({ id_cliente, cliente_nombre_libre, id_administrativo, tipo_op = 'M', observaciones = '',
          detalles, fecha_entrega_planificada, modalidad, domicilio, metodo_pago }) {
    // Crear cliente automáticamente si viene como texto libre
    if (!id_cliente && cliente_nombre_libre) {
      id_cliente = crypto.randomUUID()
      db.prepare(`INSERT INTO clientes (id, nombre, activo) VALUES (?, ?, 1)`
      ).run(id_cliente, cliente_nombre_libre.trim())
    }
    const { nro }     = db.prepare(`SELECT COALESCE(MAX(nro_op), 0) + 1 AS nro FROM op_encabezado`).get()
    const { nro_rem } = db.prepare(`SELECT COALESCE(MAX(nro_remito), 0) + 1 AS nro_rem FROM op_encabezado`).get()
    const id = crypto.randomUUID()
    const dom = domicilio || {}

    db.transaction(() => {
      db.prepare(`
        INSERT INTO op_encabezado (
          id, id_cliente, id_administrativo, tipo_op, nro_op, nro_remito, estado,
          observaciones, fecha_entrega_planificada, modalidad, metodo_pago,
          domicilio_calle, domicilio_altura, domicilio_sin_numero
        ) VALUES (?, ?, ?, ?, ?, ?, 'pendiente', ?, ?, ?, ?, ?, ?, ?)
      `).run(id, id_cliente, id_administrativo, tipo_op, nro, nro_rem,
             observaciones, fecha_entrega_planificada || null, modalidad || null,
             metodo_pago || null, dom.calle || null,
             dom.altura ? parseInt(dom.altura) : null,
             dom.sin_numero ? 1 : 0)

      for (const d of (detalles || [])) {
        db.prepare(`
          INSERT INTO op_detalle_material (id, id_orden_pedido, id_producto, cantidad_pedida, precio_unitario)
          VALUES (?, ?, ?, ?, ?)
        `).run(crypto.randomUUID(), id, d.id_producto, d.cantidad_pedida, d.precio_unitario)
        db.prepare(`UPDATE stock SET cant_pendiente_entregar = cant_pendiente_entregar + ? WHERE id_producto = ?`
        ).run(d.cantidad_pedida, d.id_producto)
      }
    })()

    return { id, nro_op: nro, nro_remito: nro_rem }
  },

  despachar(id) {
    db.prepare(`UPDATE op_encabezado SET estado = 'despachado' WHERE id = ? AND estado = 'pendiente'`).run(id)
  },

  entregar(id) {
    const op = db.prepare(`SELECT tipo_op FROM op_encabezado WHERE id = ?`).get(id)
    if (!op) return
    db.transaction(() => {
      db.prepare(`UPDATE op_encabezado SET estado = 'entregado' WHERE id = ? AND estado IN ('pendiente','despachado')`).run(id)
      const detalles = db.prepare(`SELECT id_producto, cantidad_pedida FROM op_detalle_material WHERE id_orden_pedido = ?`).all(id)
      for (const d of detalles) {
        db.prepare(`
          UPDATE stock SET cantidad_actual = MAX(0, cantidad_actual - ?),
                           cant_pendiente_entregar = MAX(0, cant_pendiente_entregar - ?)
          WHERE id_producto = ?
        `).run(d.cantidad_pedida, d.cantidad_pedida, d.id_producto)
      }
    })()
  },

  anular(id) {
    const op = db.prepare(`SELECT estado FROM op_encabezado WHERE id = ?`).get(id)
    if (!op || op.estado === 'anulado' || op.estado === 'entregado') return
    db.transaction(() => {
      db.prepare(`UPDATE op_encabezado SET estado = 'anulado' WHERE id = ?`).run(id)
      const detalles = db.prepare(`SELECT id_producto, cantidad_pedida FROM op_detalle_material WHERE id_orden_pedido = ?`).all(id)
      for (const d of detalles) {
        db.prepare(`UPDATE stock SET cant_pendiente_entregar = MAX(0, cant_pendiente_entregar - ?) WHERE id_producto = ?`
        ).run(d.cantidad_pedida, d.id_producto)
      }
    })()
  },

  // ── Vistas de cantera y viajes (compatibilidad Seminario) ─────
  listarViajesPendientesHoy() {
    const hoy = new Date().toISOString().slice(0, 10)
    return db.prepare(`
      SELECT op.id, op.nro_op, op.nro_remito, op.estado, op.fecha_emision, op.fecha_entrega_planificada,
             op.domicilio_calle, op.metodo_pago, op.observaciones,
             c.nombre AS cliente_nombre, c.tel_whatsapp,
             (SELECT COALESCE(SUM(d.cantidad_pedida * d.precio_unitario),0) FROM op_detalle_material d WHERE d.id_orden_pedido = op.id) AS total,
             (SELECT GROUP_CONCAT(p.nombre || ' x' || CAST(d.cantidad_pedida AS TEXT), ', ')
              FROM op_detalle_material d JOIN productos p ON p.id = d.id_producto
              WHERE d.id_orden_pedido = op.id) AS productos_str
      FROM op_encabezado op
      JOIN clientes c ON c.id = op.id_cliente
      WHERE op.tipo_op = 'M' AND op.modalidad = 'flete'
        AND op.estado = 'pendiente' AND op.fecha_entrega_planificada = ?
      ORDER BY op.created_at ASC
    `).all(hoy)
  },

  listarViajesPendientes() {
    return db.prepare(`
      SELECT op.id, op.nro_op, op.nro_remito, op.estado, op.fecha_emision, op.fecha_entrega_planificada,
             op.domicilio_calle, op.metodo_pago, op.observaciones,
             c.nombre AS cliente_nombre,
             (SELECT COALESCE(SUM(d.cantidad_pedida * d.precio_unitario),0) FROM op_detalle_material d WHERE d.id_orden_pedido = op.id) AS total
      FROM op_encabezado op JOIN clientes c ON c.id = op.id_cliente
      WHERE op.tipo_op = 'M' AND op.modalidad = 'flete' AND op.estado = 'pendiente'
      ORDER BY op.fecha_entrega_planificada ASC NULLS LAST
    `).all()
  },
}

module.exports = VentasModel
