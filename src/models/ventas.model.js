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

  // Construye WHERE + params compartido por listar/resumen
  _filtroVentas({ estado, id_cliente, q, fechaDesde, fechaHasta } = {}) {
    const wheres = [`op.tipo_op = 'M'`]
    const params = []
    if (estado)     { wheres.push('op.estado = ?');     params.push(estado) }
    if (id_cliente) { wheres.push('op.id_cliente = ?'); params.push(id_cliente) }
    if (fechaDesde) { wheres.push('op.fecha_emision >= ?'); params.push(fechaDesde) }
    if (fechaHasta) { wheres.push('op.fecha_emision <= ?'); params.push(fechaHasta) }
    if (q && String(q).trim()) {
      const term = `%${String(q).trim()}%`
      wheres.push(`(c.nombre LIKE ? OR op.observaciones LIKE ? OR CAST(op.nro_op AS TEXT) LIKE ?)`)
      params.push(term, term, term)
    }
    return { where: 'WHERE ' + wheres.join(' AND '), params }
  },

  // ── Listado con paginación, búsqueda y ordenamiento ───────────
  listar({ estado, id_cliente, q, fechaDesde, fechaHasta, sort, dir, page = 1, limit = 20 } = {}) {
    const { where, params } = this._filtroVentas({ estado, id_cliente, q, fechaDesde, fechaHasta })

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
      SELECT op.id, op.nro_op, op.tipo_op, op.estado, op.modalidad, op.fecha_emision, op.nro_remito,
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

  // Métricas del período/filtros (cantidad y monto total)
  resumen({ estado, id_cliente, q, fechaDesde, fechaHasta } = {}) {
    const { where, params } = this._filtroVentas({ estado, id_cliente, q, fechaDesde, fechaHasta })
    const row = db.prepare(`
      SELECT COUNT(*) AS count,
             COALESCE(SUM((SELECT COALESCE(SUM(d.cantidad_pedida * d.precio_unitario),0)
                           FROM op_detalle_material d WHERE d.id_orden_pedido = op.id)), 0) AS total
      FROM op_encabezado op
      LEFT JOIN clientes c ON c.id = op.id_cliente
      ${where}
    `).get(...params)
    return { count: row.count, total: row.total }
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

  // Actualiza datos editables de un viaje (estado != entregado/anulado).
  // Ajusta el stock pendiente si cambió la cantidad pedida.
  actualizarViaje(id, datos) {
    const op = db.prepare(`SELECT estado, modalidad FROM op_encabezado WHERE id = ?`).get(id)
    if (!op) throw new Error('Orden no encontrada.')
    if (op.estado === 'entregado') throw new Error('No se puede editar una venta ya entregada.')
    if (op.estado === 'anulado') throw new Error('No se puede editar una venta anulada.')

    const calle  = datos.calle || null
    const numero = datos.numero ? parseInt(datos.numero) : null
    const fecha  = datos.fecha || null
    const metodoPago = datos.metodoPago || null
    const observaciones = datos.descripcion || ''

    db.transaction(() => {
      db.prepare(`
        UPDATE op_encabezado
        SET fecha_entrega_planificada = ?, domicilio_calle = ?, domicilio_altura = ?,
            domicilio_sin_numero = ?, metodo_pago = COALESCE(?, metodo_pago),
            observaciones = ?
        WHERE id = ?
      `).run(fecha, calle, numero, numero ? 0 : 1, metodoPago, observaciones, id)

      // Actualizar único detalle (cantidad/precio) si corresponde
      const detalle = db.prepare(`SELECT id, id_producto, cantidad_pedida FROM op_detalle_material WHERE id_orden_pedido = ? LIMIT 1`).get(id)
      if (detalle) {
        const nuevaCant = Number(datos.cantidad) || detalle.cantidad_pedida
        const nuevoPrecio = Number(datos.precioProducto) || 0
        const delta = nuevaCant - detalle.cantidad_pedida
        db.prepare(`UPDATE op_detalle_material SET cantidad_pedida = ?, precio_unitario = ? WHERE id = ?`)
          .run(nuevaCant, nuevoPrecio, detalle.id)
        if (delta !== 0) {
          db.prepare(`UPDATE stock SET cant_pendiente_entregar = MAX(0, cant_pendiente_entregar + ?) WHERE id_producto = ?`)
            .run(delta, detalle.id_producto)
        }
      }
    })()
  },

  // Adapta una OP a la forma que esperan las vistas viaje/edit/detalle
  obtenerViaje(id) {
    const op = this.obtener(id)
    if (!op) return null
    const detalle = (op.detalles && op.detalles[0]) || {}
    const flete = 0
    const subtotal = (detalle.cantidad_pedida || 0) * (detalle.precio_unitario || 0)
    return {
      id: op.id,
      nro_op: op.nro_op,
      estado: op.estado,
      modalidad: op.modalidad,
      clienteNombre: op.cliente_nombre,
      telefono: op.tel_whatsapp || '',
      fecha: op.fecha_entrega_planificada || '',
      hora: '',
      calle: op.domicilio_calle || '',
      numero: op.domicilio_altura || '',
      productoNombre: detalle.producto_nombre || '',
      cantidad: detalle.cantidad_pedida || 1,
      precioProducto: detalle.precio_unitario || 0,
      precioFlete: flete,
      precioTotal: subtotal,
      metodoPago: op.metodo_pago || 'efectivo',
      descripcion: op.observaciones || '',
    }
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
