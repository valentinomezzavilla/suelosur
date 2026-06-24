'use strict'
const crypto = require('crypto')
const { query, transaction } = require('../config/db')

const VentasModel = {

  // ── Auxiliares ────────────────────────────────────────────────
  async listarClientes() {
    return (await query(`SELECT id, nombre, apellido, tel_whatsapp FROM clientes WHERE activo = 1 ORDER BY nombre`)).rows
  },

  async listarProductos() {
    return (await query(`
      SELECT p.id, p.nombre, p.unidad_medida, p.precio_referencia,
             (COALESCE(s.cantidad_actual,0) - COALESCE(s.cant_pendiente_entregar,0)) AS disponible_real
      FROM productos p LEFT JOIN stock s ON s.id_producto = p.id
      WHERE p.activo = 1 ORDER BY p.nombre
    `)).rows
  },

  async contarPorEstado() {
    return (await query(`SELECT estado, COUNT(*) AS total FROM op_encabezado WHERE tipo_op IN ('M') GROUP BY estado`)).rows
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
      wheres.push(`(c.nombre ILIKE? OR op.observaciones ILIKE? OR CAST(op.nro_op AS TEXT) ILIKE?)`)
      params.push(term, term, term)
    }
    return { where: 'WHERE ' + wheres.join(' AND '), params }
  },

  // ── Listado con paginación, búsqueda y ordenamiento ───────────
  async listar({ estado, id_cliente, q, fechaDesde, fechaHasta, sort, dir, page = 1, limit = 20 } = {}) {
    const { where, params } = this._filtroVentas({ estado, id_cliente, q, fechaDesde, fechaHasta })

    // Ordenamiento con whitelist (evita inyección por columna)
    const sortMap = {
      nro_op: 'op.nro_op', cliente: 'cliente_nombre', fecha: 'op.fecha_emision',
      total: 'total', estado: 'op.estado',
    }
    const orderCol = sortMap[sort] || 'op.created_at'
    const orderDir = String(dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC'

    const offset = (page - 1) * limit
    const total  = (await query(`
      SELECT COUNT(*) AS n FROM op_encabezado op
      LEFT JOIN clientes c ON c.id = op.id_cliente
      ${where}
    `, params)).rows[0]?.n || 0
    const ops = (await query(`
      SELECT op.id, op.nro_op, op.tipo_op, op.estado, op.modalidad, op.fecha_emision, op.nro_remito,
             COALESCE(c.nombre, op.observaciones, 'Particular') AS cliente_nombre,
             u.nombre AS administrativo_nombre,
             (SELECT COALESCE(SUM(d.cantidad_pedida * d.precio_unitario),0)
              FROM op_detalle_material d WHERE d.id_orden_pedido = op.id) AS total
      FROM op_encabezado op
      LEFT JOIN clientes c ON c.id = op.id_cliente
      JOIN users    u ON u.id = op.id_administrativo
      ${where} ORDER BY ${orderCol} ${orderDir} LIMIT ? OFFSET ?
    `, [...params, limit, offset])).rows
    return { ops, total, page, limit, totalPaginas: Math.ceil(total / limit) || 1 }
  },

  // Métricas del período/filtros (cantidad y monto total)
  async resumen({ estado, id_cliente, q, fechaDesde, fechaHasta } = {}) {
    const { where, params } = this._filtroVentas({ estado, id_cliente, q, fechaDesde, fechaHasta })
    const row = (await query(`
      SELECT COUNT(*) AS count,
             COALESCE(SUM((SELECT COALESCE(SUM(d.cantidad_pedida * d.precio_unitario),0)
                           FROM op_detalle_material d WHERE d.id_orden_pedido = op.id)), 0) AS total
      FROM op_encabezado op
      LEFT JOIN clientes c ON c.id = op.id_cliente
      ${where}
    `, params)).rows[0]
    return { count: row.count, total: row.total }
  },

  async obtener(id) {
    const op = (await query(`
      SELECT op.*, COALESCE(c.nombre, 'Particular') AS cliente_nombre,
             c.tel_whatsapp, c.domicilio_ppal,
             u.nombre AS administrativo_nombre
      FROM op_encabezado op
      LEFT JOIN clientes c ON c.id = op.id_cliente
      JOIN users    u ON u.id = op.id_administrativo
      WHERE op.id = ?
    `, [id])).rows[0]
    if (!op) return null
    op.detalles = (await query(`
      SELECT d.*, p.nombre AS producto_nombre, p.unidad_medida,
             (d.cantidad_pedida * d.precio_unitario) AS subtotal
      FROM op_detalle_material d JOIN productos p ON p.id = d.id_producto
      WHERE d.id_orden_pedido = ?
    `, [id])).rows
    op.total = op.detalles.reduce((s, d) => s + d.subtotal, 0)
    return op
  },

  async crear({ id_cliente, cliente_nombre_libre, id_administrativo, tipo_op = 'M', observaciones = '',
          detalles, fecha_entrega_planificada, modalidad, domicilio, metodo_pago }) {
    // Crear cliente automáticamente si viene como texto libre
    if (!id_cliente && cliente_nombre_libre) {
      id_cliente = crypto.randomUUID()
      await query(`INSERT INTO clientes (id, nombre, activo) VALUES (?, ?, 1)`,
        [id_cliente, cliente_nombre_libre.trim()])
    }
    const { nro }     = (await query(`SELECT COALESCE(MAX(nro_op), 0) + 1 AS nro FROM op_encabezado`)).rows[0]
    const { nro_rem } = (await query(`SELECT COALESCE(MAX(nro_remito), 0) + 1 AS nro_rem FROM op_encabezado`)).rows[0]
    const id = crypto.randomUUID()
    const dom = domicilio || {}

    await transaction(async (q) => {
      await q(`
        INSERT INTO op_encabezado (
          id, id_cliente, id_administrativo, tipo_op, nro_op, nro_remito, estado,
          observaciones, fecha_entrega_planificada, modalidad, metodo_pago,
          domicilio_calle, domicilio_altura, domicilio_sin_numero
        ) VALUES (?, ?, ?, ?, ?, ?, 'pendiente', ?, ?, ?, ?, ?, ?, ?)
      `, [id, id_cliente, id_administrativo, tipo_op, nro, nro_rem,
          observaciones, fecha_entrega_planificada || null, modalidad || null,
          metodo_pago || null, dom.calle || null,
          dom.altura ? parseInt(dom.altura) : null,
          dom.sin_numero ? 1 : 0])

      for (const d of (detalles || [])) {
        await q(`
          INSERT INTO op_detalle_material (id, id_orden_pedido, id_producto, cantidad_pedida, precio_unitario)
          VALUES (?, ?, ?, ?, ?)
        `, [crypto.randomUUID(), id, d.id_producto, d.cantidad_pedida, d.precio_unitario])
        await q(`UPDATE stock SET cant_pendiente_entregar = cant_pendiente_entregar + ? WHERE id_producto = ?`,
          [d.cantidad_pedida, d.id_producto])
      }
    })

    return { id, nro_op: nro, nro_remito: nro_rem }
  },

  // Actualiza datos editables de un viaje (estado != entregado/anulado).
  // Ajusta el stock pendiente si cambió la cantidad pedida.
  async actualizarViaje(id, datos) {
    const op = (await query(`SELECT estado, modalidad FROM op_encabezado WHERE id = ?`, [id])).rows[0]
    if (!op) throw new Error('Orden no encontrada.')
    if (op.estado === 'entregado') throw new Error('No se puede editar una venta ya entregada.')
    if (op.estado === 'anulado') throw new Error('No se puede editar una venta anulada.')

    const calle  = datos.calle || null
    const numero = datos.numero ? parseInt(datos.numero) : null
    const fecha  = datos.fecha || null
    const metodoPago = datos.metodoPago || null
    const observaciones = datos.descripcion || ''

    await transaction(async (q) => {
      await q(`
        UPDATE op_encabezado
        SET fecha_entrega_planificada = ?, domicilio_calle = ?, domicilio_altura = ?,
            domicilio_sin_numero = ?, metodo_pago = COALESCE(?, metodo_pago),
            observaciones = ?
        WHERE id = ?
      `, [fecha, calle, numero, numero ? 0 : 1, metodoPago, observaciones, id])

      // Actualizar único detalle (cantidad/precio) si corresponde
      const detalle = (await q(`SELECT id, id_producto, cantidad_pedida FROM op_detalle_material WHERE id_orden_pedido = ? LIMIT 1`, [id])).rows[0]
      if (detalle) {
        const nuevaCant = Number(datos.cantidad) || detalle.cantidad_pedida
        const nuevoPrecio = Number(datos.precioProducto) || 0
        const delta = nuevaCant - detalle.cantidad_pedida
        await q(`UPDATE op_detalle_material SET cantidad_pedida = ?, precio_unitario = ? WHERE id = ?`,
          [nuevaCant, nuevoPrecio, detalle.id])
        if (delta !== 0) {
          await q(`UPDATE stock SET cant_pendiente_entregar = GREATEST(0, cant_pendiente_entregar + ?) WHERE id_producto = ?`,
            [delta, detalle.id_producto])
        }
      }
    })
  },

  // Adapta una OP a la forma que esperan las vistas viaje/edit/detalle
  async obtenerViaje(id) {
    const op = await this.obtener(id)
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

  async despachar(id) {
    await query(`UPDATE op_encabezado SET estado = 'despachado' WHERE id = ? AND estado = 'pendiente'`, [id])
  },

  async entregar(id) {
    const op = (await query(`SELECT tipo_op FROM op_encabezado WHERE id = ?`, [id])).rows[0]
    if (!op) return
    await transaction(async (q) => {
      await q(`UPDATE op_encabezado SET estado = 'entregado' WHERE id = ? AND estado IN ('pendiente','despachado')`, [id])
      const detalles = (await q(`SELECT id_producto, cantidad_pedida FROM op_detalle_material WHERE id_orden_pedido = ?`, [id])).rows
      for (const d of detalles) {
        await q(`
          UPDATE stock SET cantidad_actual = GREATEST(0, cantidad_actual - ?),
                           cant_pendiente_entregar = GREATEST(0, cant_pendiente_entregar - ?)
          WHERE id_producto = ?
        `, [d.cantidad_pedida, d.cantidad_pedida, d.id_producto])
      }
    })
  },

  async anular(id) {
    const op = (await query(`SELECT estado FROM op_encabezado WHERE id = ?`, [id])).rows[0]
    if (!op || op.estado === 'anulado' || op.estado === 'entregado') return
    await transaction(async (q) => {
      await q(`UPDATE op_encabezado SET estado = 'anulado' WHERE id = ?`, [id])
      const detalles = (await q(`SELECT id_producto, cantidad_pedida FROM op_detalle_material WHERE id_orden_pedido = ?`, [id])).rows
      for (const d of detalles) {
        await q(`UPDATE stock SET cant_pendiente_entregar = GREATEST(0, cant_pendiente_entregar - ?) WHERE id_producto = ?`,
          [d.cantidad_pedida, d.id_producto])
      }
    })
  },

  // ── Vistas de cantera y viajes (compatibilidad Seminario) ─────
  async listarViajesPendientesHoy() {
    const hoy = new Date().toISOString().slice(0, 10)
    return (await query(`
      SELECT op.id, op.nro_op, op.nro_remito, op.estado, op.fecha_emision, op.fecha_entrega_planificada,
             op.domicilio_calle, op.metodo_pago, op.observaciones,
             c.nombre AS cliente_nombre, c.tel_whatsapp,
             (SELECT COALESCE(SUM(d.cantidad_pedida * d.precio_unitario),0) FROM op_detalle_material d WHERE d.id_orden_pedido = op.id) AS total,
             (SELECT STRING_AGG(p.nombre || ' x' || CAST(d.cantidad_pedida AS TEXT), ', ')
              FROM op_detalle_material d JOIN productos p ON p.id = d.id_producto
              WHERE d.id_orden_pedido = op.id) AS productos_str
      FROM op_encabezado op
      JOIN clientes c ON c.id = op.id_cliente
      WHERE op.tipo_op = 'M' AND op.modalidad = 'flete'
        AND op.estado = 'pendiente' AND op.fecha_entrega_planificada = ?
      ORDER BY op.created_at ASC
    `, [hoy])).rows
  },

  async listarViajesPendientes() {
    return (await query(`
      SELECT op.id, op.nro_op, op.nro_remito, op.estado, op.fecha_emision, op.fecha_entrega_planificada,
             op.domicilio_calle, op.metodo_pago, op.observaciones,
             c.nombre AS cliente_nombre,
             (SELECT COALESCE(SUM(d.cantidad_pedida * d.precio_unitario),0) FROM op_detalle_material d WHERE d.id_orden_pedido = op.id) AS total
      FROM op_encabezado op JOIN clientes c ON c.id = op.id_cliente
      WHERE op.tipo_op = 'M' AND op.modalidad = 'flete' AND op.estado = 'pendiente'
      ORDER BY op.fecha_entrega_planificada ASC NULLS LAST
    `)).rows
  },
}

module.exports = VentasModel
