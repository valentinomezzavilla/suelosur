'use strict'
const { query, transaction } = require('../config/db')

// Prefijos para el código legible de cada tipo de transacción
const PREFIJO = { 'Venta Cantera': 'CAN', 'Venta Viaje': 'VIA', 'Alquiler': 'CON', 'Maquinaria': 'MAQ', 'Ajuste': 'AJU' }

// Código normalizado, p.ej. CAN-000001. Fallback a TRX si no hay numero/tipo.
function codigoTransaccion(t) {
  if (!t) return ''
  const pre = PREFIJO[t.tipo] || 'TRX'
  if (t.numero == null) return `${pre}-——`
  return `${pre}-${String(t.numero).padStart(6, '0')}`
}

const TransaccionesModel = {

  PREFIJO,
  codigo: codigoTransaccion,

  async crear({ tipo, id_op_encabezado, nro_remito, cliente_id, cliente, monto, descripcion, metodo_pago, fecha }) {
    const { n } = (await query(`SELECT COALESCE(MAX(numero),0) + 1 AS n FROM transacciones WHERE tipo = ?`, [tipo])).rows[0]
    // fecha opcional: si no se pasa, usa la fecha/hora actual (carga histórica la puede fijar en el pasado).
    const { rows } = await query(`
      INSERT INTO transacciones (tipo, numero, id_op_encabezado, nro_remito, cliente_id, cliente, monto, descripcion, metodo_pago, fecha)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')))
      RETURNING id
    `, [tipo, n, id_op_encabezado || null, nro_remito || null, cliente_id || null,
        cliente || '', monto || 0, descripcion || '', metodo_pago || 'efectivo', fecha || null])
    return rows[0].id
  },

  // ¿La operación ya generó su ingreso? Evita cobrar dos veces la misma operación
  // (por ejemplo, alquileres viejos que ya habían cobrado al entregar).
  async existePorOperacion(id_op_encabezado) {
    if (!id_op_encabezado) return false
    const r = (await query(`SELECT 1 FROM transacciones WHERE id_op_encabezado = ? LIMIT 1`, [id_op_encabezado])).rows[0]
    return !!r
  },

  async obtener(id) {
    return (await query(`SELECT * FROM transacciones WHERE id = ?`, [id])).rows[0]
  },

  // Elimina la transacción y, si tiene una operación detrás, la operación entera con
  // todo lo que cuelga de ella. Si solo se borrara la transacción, la operación
  // seguiría contando en el dashboard y en los listados.
  // El orden importa: ninguna FK está en cascada, así que van primero los hijos.
  async eliminar(id) {
    const tx = (await query(`SELECT id, id_op_encabezado FROM transacciones WHERE id = ?`, [id])).rows[0]
    if (!tx) throw new Error('La transacción no existe.')
    const idOp = tx.id_op_encabezado

    // Estado de la operación: define qué stock hay que devolver
    const op = idOp
      ? (await query(`SELECT estado FROM op_encabezado WHERE id = ?`, [idOp])).rows[0]
      : null

    await transaction(async (q) => {
      await q(`DELETE FROM transacciones WHERE id = ?`, [id])
      if (!idOp) return

      // Devolver el stock que la operación había movido, si no la operación
      // desaparece pero el material sigue descontado.
      //  · entregada  → ya salió de planta: vuelve a cantidad_actual
      //  · en curso   → estaba reservado: se libera lo pendiente de entregar
      //  · anulada    → el stock ya se había liberado al anularla
      if (op && op.estado !== 'anulado') {
        const detalles = (await q(
          `SELECT id_producto, cantidad_pedida FROM op_detalle_material WHERE id_orden_pedido = ?`, [idOp])).rows
        for (const d of detalles) {
          if (op.estado === 'entregado') {
            await q(`UPDATE stock SET cantidad_actual = cantidad_actual + ? WHERE id_producto = ?`,
              [d.cantidad_pedida, d.id_producto])
          } else {
            await q(`UPDATE stock SET cant_pendiente_entregar = GREATEST(0, cant_pendiente_entregar - ?) WHERE id_producto = ?`,
              [d.cantidad_pedida, d.id_producto])
          }
        }
      }

      // Movimientos de contenedor / maquinaria (cuelgan del detalle, no de la op)
      await q(`DELETE FROM movimiento_contenedor WHERE id_op_contenedor IN
               (SELECT id FROM op_detalle_contenedor WHERE id_orden_pedido = ?)`, [idOp])
      await q(`DELETE FROM movimiento_maquinaria WHERE id_op_maquinaria IN
               (SELECT id FROM op_detalle_maquinaria WHERE id_orden_pedido = ?)`, [idOp])

      // Un alquiler puede estar encadenado como "próximo" de otro: hay que soltarlo
      await q(`UPDATE op_detalle_contenedor SET alquiler_siguiente_id = NULL WHERE alquiler_siguiente_id = ?`, [idOp])

      await q(`DELETE FROM op_detalle_contenedor WHERE id_orden_pedido = ?`, [idOp])
      await q(`DELETE FROM op_detalle_maquinaria WHERE id_orden_pedido = ?`, [idOp])
      await q(`DELETE FROM op_detalle_material   WHERE id_orden_pedido = ?`, [idOp])
      await q(`DELETE FROM circuito_paradas      WHERE id_op_encabezado = ?`, [idOp])
      await q(`DELETE FROM historial_kilometraje WHERE id_op = ?`, [idOp])
      await q(`DELETE FROM rastreo_chofer        WHERE id_op = ?`, [idOp])
      // Otras transacciones de la misma operación (no debería haber, pero por las dudas)
      await q(`DELETE FROM transacciones WHERE id_op_encabezado = ?`, [idOp])
      await q(`DELETE FROM op_encabezado WHERE id = ?`, [idOp])
    })
    return { id, id_op_encabezado: idOp }
  },

  async listar() {
    return (await query(`SELECT * FROM transacciones ORDER BY created_at DESC`)).rows
  },

  async filtrar({ id, tipo, clienteId, cliente, fechaDesde, fechaHasta, montoMin, montoMax, page = 1, limit = 20, sortBy = 'created_at', sortDir = 'DESC' } = {}) {
    const wheres = []
    const params = []
    if (id)         { wheres.push('id = ?');                  params.push(id) }
    if (tipo && tipo !== 'todos') { wheres.push('tipo = ?');  params.push(tipo) }
    if (clienteId)  { wheres.push('cliente_id = ?');          params.push(clienteId) }
    if (cliente)    { wheres.push('cliente ILIKE ?');          params.push(`%${cliente}%`) }
    if (fechaDesde) { wheres.push('fecha >= ?');              params.push(fechaDesde) }
    if (fechaHasta) { wheres.push('fecha <= ?');              params.push(fechaHasta) }
    if (montoMin)   { wheres.push('monto >= ?');              params.push(Number(montoMin)) }
    if (montoMax)   { wheres.push('monto <= ?');              params.push(Number(montoMax)) }
    const where = wheres.length ? 'WHERE ' + wheres.join(' AND ') : ''

    const validSorts = { created_at: 'created_at', monto: 'monto', fecha: 'fecha', tipo: 'tipo' }
    const orderCol = validSorts[sortBy] || 'created_at'
    const orderDir = sortDir === 'ASC' ? 'ASC' : 'DESC'
    const offset = (page - 1) * limit

    const total = (await query(`SELECT COUNT(*) AS n FROM transacciones ${where}`, params)).rows[0]?.n || 0
    const sumaTotal = (await query(`SELECT COALESCE(SUM(monto), 0) AS s FROM transacciones ${where}`, params)).rows[0]?.s || 0
    const rows = (await query(`
      SELECT sub.*,
             (oe.archivo_remito IS NOT NULL AND oe.archivo_remito <> '') AS tiene_remito_firmado
      FROM (SELECT * FROM transacciones ${where}) sub
      LEFT JOIN op_encabezado oe ON oe.id = sub.id_op_encabezado
      ORDER BY sub.${orderCol} ${orderDir} LIMIT ? OFFSET ?
    `, [...params, limit, offset])).rows

    return { rows, total, sumaTotal, page, limit, totalPaginas: Math.ceil(total / limit) }
  },

  // Métricas agregadas del período/filtros (para las cards)
  async resumen({ id, tipo, clienteId, cliente, fechaDesde, fechaHasta, montoMin, montoMax } = {}) {
    const wheres = []
    const params = []
    if (id)         { wheres.push('id = ?');                 params.push(id) }
    if (tipo && tipo !== 'todos') { wheres.push('tipo = ?'); params.push(tipo) }
    if (clienteId)  { wheres.push('cliente_id = ?');         params.push(clienteId) }
    if (cliente)    { wheres.push('cliente ILIKE ?');         params.push(`%${cliente}%`) }
    if (fechaDesde) { wheres.push('fecha >= ?');             params.push(fechaDesde) }
    if (fechaHasta) { wheres.push('fecha <= ?');             params.push(fechaHasta) }
    if (montoMin)   { wheres.push('monto >= ?');             params.push(Number(montoMin)) }
    if (montoMax)   { wheres.push('monto <= ?');             params.push(Number(montoMax)) }
    const where = wheres.length ? 'WHERE ' + wheres.join(' AND ') : ''

    const rows = (await query(`SELECT tipo, COUNT(*) AS c, COALESCE(SUM(monto),0) AS s FROM transacciones ${where} GROUP BY tipo`, params)).rows
    let total = 0, count = 0
    const porTipo = {}
    rows.forEach(r => { total += r.s; count += r.c; porTipo[r.tipo] = { monto: r.s, count: r.c } })
    const sumTipos = (...t) => t.reduce((a, k) => a + (porTipo[k]?.monto || 0), 0)
    return {
      total, count, porTipo,
      ventas: sumTipos('Venta Cantera', 'Venta Viaje'),
      alquileres: sumTipos('Alquiler', 'Maquinaria'),
    }
  },
}

module.exports = TransaccionesModel
