'use strict'
const crypto = require('crypto')
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

  async crear({ tipo, id_op_encabezado, nro_remito, cliente_id, cliente, monto, descripcion, metodo_pago }) {
    const id = crypto.randomUUID()
    const { n } = (await query(`SELECT COALESCE(MAX(numero),0) + 1 AS n FROM transacciones WHERE tipo = ?`, [tipo])).rows[0]
    await query(`
      INSERT INTO transacciones (id, tipo, numero, id_op_encabezado, nro_remito, cliente_id, cliente, monto, descripcion, metodo_pago)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [id, tipo, n, id_op_encabezado || null, nro_remito || null, cliente_id || null,
        cliente || '', monto || 0, descripcion || '', metodo_pago || 'efectivo'])
    return id
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
    const rows = (await query(`SELECT * FROM transacciones ${where} ORDER BY ${orderCol} ${orderDir} LIMIT ? OFFSET ?`, [...params, limit, offset])).rows

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
