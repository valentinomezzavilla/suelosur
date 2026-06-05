'use strict'
const crypto = require('crypto')
const db = require('../config/db')

const TransaccionesModel = {

  crear({ tipo, id_op_encabezado, nro_remito, cliente_id, cliente, monto, descripcion, metodo_pago }) {
    const id = crypto.randomUUID()
    db.prepare(`
      INSERT INTO transacciones (id, tipo, id_op_encabezado, nro_remito, cliente_id, cliente, monto, descripcion, metodo_pago)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, tipo, id_op_encabezado || null, nro_remito || null, cliente_id || null,
           cliente || '', monto || 0, descripcion || '', metodo_pago || 'efectivo')
    return id
  },

  listar() {
    return db.prepare(`SELECT * FROM transacciones ORDER BY created_at DESC`).all()
  },

  filtrar({ id, tipo, clienteId, cliente, fechaDesde, fechaHasta, montoMin, montoMax, page = 1, limit = 20, sortBy = 'created_at', sortDir = 'DESC' } = {}) {
    const wheres = []
    const params = []
    if (id)         { wheres.push('id = ?');                  params.push(id) }
    if (tipo && tipo !== 'todos') { wheres.push('tipo = ?');  params.push(tipo) }
    if (clienteId)  { wheres.push('cliente_id = ?');          params.push(clienteId) }
    if (cliente)    { wheres.push('cliente LIKE ?');          params.push(`%${cliente}%`) }
    if (fechaDesde) { wheres.push('fecha >= ?');              params.push(fechaDesde) }
    if (fechaHasta) { wheres.push('fecha <= ?');              params.push(fechaHasta) }
    if (montoMin)   { wheres.push('monto >= ?');              params.push(Number(montoMin)) }
    if (montoMax)   { wheres.push('monto <= ?');              params.push(Number(montoMax)) }
    const where = wheres.length ? 'WHERE ' + wheres.join(' AND ') : ''

    const validSorts = { created_at: 'created_at', monto: 'monto', fecha: 'fecha', tipo: 'tipo' }
    const orderCol = validSorts[sortBy] || 'created_at'
    const orderDir = sortDir === 'ASC' ? 'ASC' : 'DESC'
    const offset = (page - 1) * limit

    const total = db.prepare(`SELECT COUNT(*) AS n FROM transacciones ${where}`).get(...params).n
    const sumaTotal = db.prepare(`SELECT COALESCE(SUM(monto), 0) AS s FROM transacciones ${where}`).get(...params).s
    const rows = db.prepare(`SELECT * FROM transacciones ${where} ORDER BY ${orderCol} ${orderDir} LIMIT ? OFFSET ?`).all(...params, limit, offset)

    return { rows, total, sumaTotal, page, limit, totalPaginas: Math.ceil(total / limit) }
  },
}

module.exports = TransaccionesModel
