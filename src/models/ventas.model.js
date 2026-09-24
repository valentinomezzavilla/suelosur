'use strict'
const { query, transaction } = require('../config/db')
const { SQL_SIGUIENTE_NRO_OP } = require('../utils/numeracion')
const FlotaModel = require('./flota.model')
const ClientesModel = require('./clientes.model')
const ProductosModel = require('./productos.model')
const { cotizarContenedor, SQL_DESCRIPCION_DETALLE, SQL_UNIDAD_DETALLE } = require('../utils/contenedor')
const { textoDestino } = require('../utils/destino')

// Total de una venta: el pactado (monto_total) cuando se guardó; si no, productos + flete.
// Es la misma cuenta en listados, detalle, remito y al generar la transacción.
const SQL_SUBTOTAL = `(SELECT COALESCE(SUM(d.cantidad_pedida * d.precio_unitario),0)
                       FROM op_detalle_material d WHERE d.id_orden_pedido = op.id)`
const SQL_TOTAL = `COALESCE(op.monto_total, ${SQL_SUBTOTAL} + COALESCE(op.precio_flete, 0))`

const redondear = (n) => Math.round((Number(n) || 0) * 100) / 100

// Productos, flete y la diferencia con el total pactado (si se editó a mano).
function importesVenta(op, subtotal) {
  const flete = Number(op.precio_flete) || 0
  const total = op.monto_total != null ? Number(op.monto_total) : subtotal + flete
  const ajuste = redondear(total - subtotal - flete)
  return { subtotal, flete, total, ajuste: Math.abs(ajuste) < 0.01 ? 0 : ajuste }
}

const VentasModel = {

  // ── Auxiliares ────────────────────────────────────────────────
  async listarClientes() {
    return (await query(`SELECT id, nombre, apellido, tel_whatsapp FROM clientes WHERE activo = 1 ORDER BY nombre`)).rows
  },

  async listarProductos() {
    return ProductosModel.conRangos((await query(`
      SELECT p.id, p.nombre, p.unidad_medida, p.precio_cantera, p.precio_viaje, p.es_contenedor,
             (COALESCE(s.cantidad_actual,0) - COALESCE(s.cant_pendiente_entregar,0)) AS disponible_real
      FROM productos p LEFT JOIN stock s ON s.id_producto = p.id
      WHERE p.activo = 1 ORDER BY p.nombre
    `)).rows)
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
      wheres.push(`(c.nombre ILIKE ? OR op.observaciones ILIKE ? OR CAST(op.nro_op AS TEXT) ILIKE ?)`)
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
      SELECT op.id, op.nro_op, op.tipo_op, op.estado, op.modalidad, op.fecha_emision, op.nro_remito, op.metodo_pago,
             COALESCE(c.nombre, op.observaciones, 'Particular') AS cliente_nombre,
             u.nombre AS administrativo_nombre,
             ${SQL_TOTAL} AS total
      FROM op_encabezado op
      LEFT JOIN clientes c ON c.id = op.id_cliente
      JOIN users    u ON u.id = op.id_administrativo
      ${where} ORDER BY ${orderCol} ${orderDir} LIMIT ? OFFSET ?
    `, [...params, limit, offset])).rows

    // Ventas a cuenta corriente no anuladas (tienen su cargo desde que se registran): venta por venta,
    // ¿el cliente ya la saldó? (ver ClientesModel.saldadaPorOperacion)
    const idsCC = ops.filter(o => o.metodo_pago === 'cuenta_corriente' && o.estado !== 'anulado').map(o => o.id)
    const saldadas = await ClientesModel.saldadaPorOperacion(idsCC)
    ops.forEach(o => { if (idsCC.includes(o.id)) o.saldada = !!saldadas[o.id] })

    return { ops, total, page, limit, totalPaginas: Math.ceil(total / limit) || 1 }
  },

  // Métricas del período/filtros (cantidad y monto total)
  async resumen({ estado, id_cliente, q, fechaDesde, fechaHasta } = {}) {
    const { where, params } = this._filtroVentas({ estado, id_cliente, q, fechaDesde, fechaHasta })
    const row = (await query(`
      SELECT COUNT(*) AS count,
             COALESCE(SUM(${SQL_TOTAL}), 0) AS total
      FROM op_encabezado op
      LEFT JOIN clientes c ON c.id = op.id_cliente
      ${where}
    `, params)).rows[0]
    return { count: row.count, total: row.total }
  },

  async obtener(id) {
    const op = (await query(`
      SELECT op.*, COALESCE(c.nombre, 'Particular') AS cliente_nombre,
             c.apellido AS cliente_apellido, c.tel_whatsapp, c.telefono AS cliente_telefono,
             c.domicilio_ppal, c.dni AS cliente_dni, c.email AS cliente_email,
             c.zona AS cliente_zona, c.tipo_cliente AS cliente_tipo,
             c.cuenta_corriente AS cliente_cc, c.saldo AS cliente_saldo, c.numero AS cliente_numero,
             u.nombre AS administrativo_nombre
      FROM op_encabezado op
      LEFT JOIN clientes c ON c.id = op.id_cliente
      JOIN users    u ON u.id = op.id_administrativo
      WHERE op.id = ?
    `, [id])).rows[0]
    if (!op) return null
    op.detalles = (await query(`
      SELECT d.*, ${SQL_DESCRIPCION_DETALLE} AS producto_nombre, ${SQL_UNIDAD_DETALLE} AS unidad_medida,
             p.nombre AS producto, p.es_contenedor,
             (d.cantidad_pedida * d.precio_unitario) AS subtotal
      FROM op_detalle_material d JOIN productos p ON p.id = d.id_producto
      WHERE d.id_orden_pedido = ?
    `, [id])).rows
    const imp = importesVenta(op, op.detalles.reduce((s, d) => s + d.subtotal, 0))
    op.subtotal_productos = imp.subtotal
    op.precio_flete = imp.flete
    op.ajuste = imp.ajuste
    op.total = imp.total
    return op
  },

  async crear({ id_cliente, cliente_nombre_libre, id_administrativo, tipo_op = 'M', observaciones = '',
          detalles, fecha_entrega_planificada, hora_planificada, modalidad, domicilio, metodo_pago, zona, obra,
          fecha_emision, precio_flete = null, monto_total = null, nro_remito = null }) {
    // Crear cliente automáticamente si viene como texto libre
    if (!id_cliente && cliente_nombre_libre) {
      const cli = await query(`INSERT INTO clientes (nombre, activo) VALUES (?, 1) RETURNING id`,
        [cliente_nombre_libre.trim()])
      id_cliente = cli.rows[0].id
    }
    const { nro }     = (await query(`SELECT ${SQL_SIGUIENTE_NRO_OP} AS nro`)).rows[0]
    // Remito: el que se cargó a mano (talonario) o, si no, el siguiente de la secuencia
    const { nro_rem: nroSiguiente } = (await query(`SELECT COALESCE(MAX(nro_remito), 0) + 1 AS nro_rem FROM op_encabezado`)).rows[0]
    const nro_rem = nro_remito || nroSiguiente
    const dom = domicilio || {}

    return await transaction(async (q) => {
      const { rows } = await q(`
        INSERT INTO op_encabezado (
          id_cliente, id_administrativo, tipo_op, nro_op, nro_remito, estado,
          observaciones, fecha_entrega_planificada, hora_planificada, modalidad, metodo_pago,
          domicilio_calle, domicilio_altura, domicilio_sin_numero, zona, obra, fecha_emision,
          precio_flete, monto_total
        ) VALUES (?, ?, ?, ?, ?, 'pendiente', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                  COALESCE(?, to_char(CURRENT_DATE, 'YYYY-MM-DD')), ?, ?)
        RETURNING id
      `, [id_cliente, id_administrativo, tipo_op, nro, nro_rem,
          observaciones, fecha_entrega_planificada || null, hora_planificada || null, modalidad || null,
          metodo_pago || null, dom.calle || null,
          dom.altura ? parseInt(dom.altura) : null,
          dom.sin_numero ? 1 : 0, zona || null, obra || null, fecha_emision || null,
          precio_flete, monto_total])
      const id = rows[0].id

      for (const d of (detalles || [])) {
        // Renglón de contenedor: lleva días y precio por día, y no reserva stock
        const dias = d.dias != null ? d.dias : null
        await q(`
          INSERT INTO op_detalle_material (id_orden_pedido, id_producto, cantidad_pedida, precio_unitario, dias, precio_dia)
          VALUES (?, ?, ?, ?, ?, ?)
        `, [id, d.id_producto, d.cantidad_pedida, d.precio_unitario, dias, dias != null ? d.precio_dia : null])
        if (dias != null) continue
        await q(`UPDATE stock SET cant_pendiente_entregar = cant_pendiente_entregar + ? WHERE id_producto = ?`,
          [d.cantidad_pedida, d.id_producto])
      }

      return { id, nro_op: nro, nro_remito: nro_rem }
    })
  },

  // Actualiza datos editables de un viaje (estado != entregado/anulado).
  // Ajusta el stock pendiente si cambió la cantidad pedida.
  async actualizarViaje(id, datos) {
    const op = (await query(`SELECT estado, modalidad, precio_flete, id_cliente FROM op_encabezado WHERE id = ?`, [id])).rows[0]
    if (!op) throw new Error('Orden no encontrada.')
    if (datos.metodoPago === 'cuenta_corriente') {
      const errCC = await ClientesModel.errorCuentaCorriente(op.id_cliente)
      if (errCC) throw new Error(errCC)
    }
    if (op.estado === 'entregado') throw new Error('No se puede editar una venta ya entregada.')
    if (op.estado === 'anulado') throw new Error('No se puede editar una venta anulada.')

    const calle  = (datos.calle || '').trim() || null
    const numero = datos.numero ? parseInt(datos.numero) : null
    const obra   = (datos.obra || '').trim() || null
    if (!calle && !obra) throw new Error('Cargá la dirección (calle) o la obra. Al menos uno es obligatorio.')
    const fecha  = datos.fecha || null
    const hora   = datos.hora || null
    const zona   = datos.zona || null
    const metodoPago = datos.metodoPago || null
    const observaciones = datos.descripcion || ''
    const vacio  = (v) => v == null || String(v).trim() === ''
    const flete  = vacio(datos.precioFlete) ? (Number(op.precio_flete) || 0) : Math.max(0, Number(datos.precioFlete) || 0)

    await transaction(async (q) => {
      // Único detalle (cantidad/precio): si no vino un campo, se conserva el valor actual
      const detalle = (await q(`SELECT id, id_producto, cantidad_pedida, precio_unitario, dias, precio_dia FROM op_detalle_material WHERE id_orden_pedido = ? LIMIT 1`, [id])).rows[0]
      let subtotal = 0
      if (detalle && detalle.dias != null) {
        // Contenedor: siempre 1. Se editan los días; el precio por día es el que se cargó
        // o, si no vino, el del rango que corresponde a esos días.
        const dias = vacio(datos.dias) ? detalle.dias : Number(datos.dias)
        if (!Number.isInteger(dias) || dias < 1) throw new Error('Los días del contenedor tienen que ser un número entero, mínimo 1.')
        let precioDia
        if (!vacio(datos.precioDia)) {
          precioDia = Math.max(0, Number(datos.precioDia) || 0)
        } else {
          const rangos = (await ProductosModel.rangosDe([detalle.id_producto]))[String(detalle.id_producto)] || []
          const cot = cotizarContenedor(rangos, dias)
          if (cot.error) throw new Error(cot.error)
          precioDia = cot.precio_dia
        }
        subtotal = dias * precioDia
        await q(`UPDATE op_detalle_material SET cantidad_pedida = 1, dias = ?, precio_dia = ?, precio_unitario = ? WHERE id = ?`,
          [dias, precioDia, subtotal, detalle.id])
      } else if (detalle) {
        const nuevaCant = Number(datos.cantidad) > 0 ? Number(datos.cantidad) : detalle.cantidad_pedida
        const nuevoPrecio = vacio(datos.precioProducto) ? detalle.precio_unitario : Math.max(0, Number(datos.precioProducto) || 0)
        const delta = nuevaCant - detalle.cantidad_pedida
        await q(`UPDATE op_detalle_material SET cantidad_pedida = ?, precio_unitario = ? WHERE id = ?`,
          [nuevaCant, nuevoPrecio, detalle.id])
        if (delta !== 0) {
          await q(`UPDATE stock SET cant_pendiente_entregar = GREATEST(0, cant_pendiente_entregar + ?) WHERE id_producto = ?`,
            [delta, detalle.id_producto])
        }
        subtotal = nuevaCant * nuevoPrecio
      }
      // Total: el editado a mano si se tildó, si no productos + flete
      const totalManual = String(datos.editarTotal) === '1' && !vacio(datos.precioTotal)
      const total = totalManual ? Math.max(0, Number(datos.precioTotal) || 0) : subtotal + flete

      await q(`
        UPDATE op_encabezado
        SET fecha_entrega_planificada = ?, hora_planificada = ?, zona = ?,
            domicilio_calle = ?, domicilio_altura = ?, obra = ?,
            domicilio_sin_numero = ?, metodo_pago = COALESCE(?, metodo_pago),
            observaciones = ?, precio_flete = ?, monto_total = ?
        WHERE id = ?
      `, [fecha, hora, zona, calle, numero, obra, numero ? 0 : 1, metodoPago, observaciones, flete, total, id])
      // Cambió el total o el método: el cargo en cuenta corriente acompaña
      await VentasModel.sincronizarCargoCC(id, q)
    })
  },

  // Adapta una OP a la forma que esperan las vistas viaje/edit/detalle
  async obtenerViaje(id) {
    const op = await this.obtener(id)
    if (!op) return null
    const detalle = (op.detalles && op.detalles[0]) || {}
    const subtotal = (detalle.cantidad_pedida || 0) * (detalle.precio_unitario || 0)
    return {
      id: op.id,
      nro_op: op.nro_op,
      estado: op.estado,
      modalidad: op.modalidad,
      clienteNombre: op.cliente_nombre,
      telefono: op.tel_whatsapp || '',
      fecha: op.fecha_entrega_planificada || '',
      hora: op.hora_planificada || '',
      zona: op.zona || '',
      calle: op.domicilio_calle || '',
      numero: op.domicilio_altura || '',
      obra: op.obra || '',
      direccion: [op.domicilio_calle, op.domicilio_altura].filter(Boolean).join(' ').trim(),
      productoNombre: detalle.producto || detalle.producto_nombre || '',
      idProducto: detalle.id_producto,
      esContenedor: detalle.dias != null,
      dias: detalle.dias,
      precioDia: detalle.precio_dia,
      rangos: detalle.dias != null
        ? ((await ProductosModel.rangosDe([detalle.id_producto]))[String(detalle.id_producto)] || [])
        : [],
      cantidad: detalle.cantidad_pedida || 1,
      precioProducto: detalle.precio_unitario || 0,
      subtotal,
      precioFlete: op.precio_flete,
      precioTotal: op.total,
      totalManual: op.ajuste !== 0,
      metodoPago: op.metodo_pago || 'efectivo',
      descripcion: op.observaciones || '',
    }
  },

  async despachar(id) {
    await query(`UPDATE op_encabezado SET estado = 'despachado' WHERE id = ? AND estado = 'pendiente'`, [id])
    // Camión "en viaje" automáticamente (no toca estados manuales)
    await FlotaModel.setEnUso(await FlotaModel.camionDeOperacion(id), true)
  },

  async entregar(id) {
    const op = (await query(`SELECT tipo_op FROM op_encabezado WHERE id = ?`, [id])).rows[0]
    if (!op) return
    await transaction(async (q) => {
      await q(`UPDATE op_encabezado SET estado = 'entregado' WHERE id = ? AND estado IN ('pendiente','despachado')`, [id])
      // Los renglones de contenedor (dias no nulo) no mueven stock
      const detalles = (await q(`SELECT id_producto, cantidad_pedida FROM op_detalle_material WHERE id_orden_pedido = ? AND dias IS NULL`, [id])).rows
      for (const d of detalles) {
        await q(`
          UPDATE stock SET cantidad_actual = GREATEST(0, cantidad_actual - ?),
                           cant_pendiente_entregar = GREATEST(0, cant_pendiente_entregar - ?)
          WHERE id_producto = ?
        `, [d.cantidad_pedida, d.cantidad_pedida, d.id_producto])
      }
    })
    // Viaje terminado: el camión vuelve a "disponible" automáticamente
    await FlotaModel.setEnUso(await FlotaModel.camionDeOperacion(id), false)
  },

  async anular(id) {
    const op = (await query(`SELECT estado FROM op_encabezado WHERE id = ?`, [id])).rows[0]
    if (!op || op.estado === 'anulado' || op.estado === 'entregado') return
    // Si se anula, liberar el camión
    await FlotaModel.setEnUso(await FlotaModel.camionDeOperacion(id), false)
    await transaction(async (q) => {
      await q(`UPDATE op_encabezado SET estado = 'anulado' WHERE id = ?`, [id])
      // Anulada: si era a cuenta corriente, el cargo se revierte
      await VentasModel.sincronizarCargoCC(id, q)
      // Los renglones de contenedor (dias no nulo) no mueven stock
      const detalles = (await q(`SELECT id_producto, cantidad_pedida FROM op_detalle_material WHERE id_orden_pedido = ? AND dias IS NULL`, [id])).rows
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
             ${SQL_TOTAL} AS total,
             (SELECT STRING_AGG(${SQL_DESCRIPCION_DETALLE} || ' x' || CAST(d.cantidad_pedida AS TEXT), ', ')
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
             ${SQL_TOTAL} AS total
      FROM op_encabezado op JOIN clientes c ON c.id = op.id_cliente
      WHERE op.tipo_op = 'M' AND op.modalidad = 'flete' AND op.estado = 'pendiente'
      ORDER BY op.fecha_entrega_planificada ASC NULLS LAST
    `)).rows
  },
}

// ── Cuenta corriente ────────────────────────────────────────────
// Regla única: una venta a cuenta corriente que no está anulada tiene EXACTAMENTE UN
// cargo en la cuenta del cliente, por su total, desde el momento en que se registra.
// Cualquier otra venta no tiene ninguno. Se llama después de crear, editar, entregar,
// anular o cambiar el método de pago: deja el cargo como corresponde (lo crea, ajusta
// el importe o el cliente, o lo borra) y mantiene clientes.saldo en línea.
// `q` permite correrlo dentro de una transacción abierta.
VentasModel.sincronizarCargoCC = async function (idOp, q = query) {
  const op = (await q(`
    SELECT op.id, op.nro_op, op.tipo_op, op.estado, op.metodo_pago, op.id_cliente, op.modalidad,
           op.obra, op.domicilio_calle, op.domicilio_altura, op.fecha_emision, op.observaciones,
           ${SQL_TOTAL} AS total
    FROM op_encabezado op WHERE op.id = ?
  `, [idOp])).rows[0]
  if (!op || op.tipo_op !== 'M') return null

  const corresponde = op.metodo_pago === 'cuenta_corriente' && !!op.id_cliente && op.estado !== 'anulado'
  const cargos = (await q(
    `SELECT id, cliente_id, monto FROM movimientos_cuenta WHERE id_op_encabezado = ? AND tipo = 'deuda' ORDER BY id`, [idOp]
  )).rows
  // Se conserva a lo sumo uno (el más viejo); el resto son duplicados
  const actual = corresponde ? cargos[0] : null
  let cambio = null
  for (const c of cargos) {
    if (c === actual) continue
    await q(`DELETE FROM movimientos_cuenta WHERE id = ?`, [c.id])
    await q(`UPDATE clientes SET saldo = saldo - ? WHERE id = ?`, [Number(c.monto), c.cliente_id])
    cambio = corresponde ? 'duplicado borrado' : 'cargo borrado'
  }
  if (!corresponde) return cambio

  const monto = -redondear(op.total)
  const nro = `OP-${String(op.nro_op).padStart(4, '0')}`
  const destino = op.modalidad === 'flete'
    ? textoDestino({ calle: op.domicilio_calle, numero: op.domicilio_altura, obra: op.obra }) : ''
  const descripcion = op.modalidad === 'flete'
    ? `Venta Viaje ${nro}${destino ? ': ' + destino : ''}`
    : `Venta Cantera ${nro}${op.observaciones ? ': ' + String(op.observaciones).slice(0, 140) : ''}`

  if (actual) {
    const cambioCliente = String(actual.cliente_id) !== String(op.id_cliente)
    if (cambioCliente || Math.abs(Number(actual.monto) - monto) > 0.005) {
      await q(`UPDATE clientes SET saldo = saldo - ? WHERE id = ?`, [Number(actual.monto), actual.cliente_id])
      await q(`UPDATE movimientos_cuenta SET cliente_id = ?, monto = ?, descripcion = ? WHERE id = ?`,
        [op.id_cliente, monto, descripcion, actual.id])
      await q(`UPDATE clientes SET saldo = saldo + ? WHERE id = ?`, [monto, op.id_cliente])
      return `cargo ajustado a ${-monto}`
    }
    return cambio
  }
  // Venta cargada con fecha pasada: el cargo va en esa fecha (igual que su transacción)
  const hoy = new Date().toISOString().slice(0, 10)
  const fecha = String(op.fecha_emision || '').slice(0, 10)
  const createdAt = fecha && fecha < hoy ? `${fecha} 12:00:00` : null
  await q(`
    INSERT INTO movimientos_cuenta (cliente_id, tipo, descripcion, monto, id_op_encabezado, created_at)
    VALUES (?, 'deuda', ?, ?, ?, COALESCE(?, to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')))
  `, [op.id_cliente, descripcion, monto, op.id, createdAt])
  await q(`UPDATE clientes SET saldo = saldo + ? WHERE id = ?`, [monto, op.id_cliente])
  return `cargo creado por ${-monto}`
}

// Pone en regla todas las ventas a cuenta corriente (idempotente). Corre al arrancar:
// completa cargos que faltaban, corrige importes y quita los de ventas anuladas.
VentasModel.sincronizarTodosLosCargosCC = async function () {
  const ops = (await query(`
    SELECT DISTINCT op.id, op.nro_op FROM op_encabezado op
    WHERE op.tipo_op = 'M' AND (op.metodo_pago = 'cuenta_corriente'
       OR EXISTS (SELECT 1 FROM movimientos_cuenta m WHERE m.id_op_encabezado = op.id AND m.tipo = 'deuda'))
    ORDER BY op.id
  `)).rows
  const cambios = []
  for (const o of ops) {
    const cambio = await transaction(q => VentasModel.sincronizarCargoCC(o.id, q))
    if (cambio) cambios.push(`OP-${String(o.nro_op).padStart(4, '0')}: ${cambio}`)
  }
  return cambios
}

VentasModel.importesVenta = importesVenta

module.exports = VentasModel
