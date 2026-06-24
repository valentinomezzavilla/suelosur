'use strict'
// Gastos del vehículo: seguros, impuestos, peajes, estacionamientos, multas, otros.
const crypto = require('crypto')
const { query } = require('../config/db')

const GastosVehiculoModel = {

  async listar(id_vehiculo, { desde, hasta, categoria } = {}) {
    const wheres = ['id_vehiculo = ?']
    const params = [id_vehiculo]
    if (desde) { wheres.push('fecha >= ?'); params.push(desde) }
    if (hasta) { wheres.push('fecha <= ?'); params.push(hasta) }
    if (categoria) { wheres.push('categoria = ?'); params.push(categoria) }
    return (await query(`SELECT * FROM gastos_vehiculo WHERE ${wheres.join(' AND ')} ORDER BY fecha DESC, created_at DESC`, params)).rows
  },

  async crear({ id_vehiculo, categoria, descripcion, monto, fecha, vencimiento, estado, archivo }) {
    const id = crypto.randomUUID()
    await query(`
      INSERT INTO gastos_vehiculo (id, id_vehiculo, categoria, descripcion, monto, fecha, vencimiento, estado, archivo)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [id, id_vehiculo, categoria, descripcion || '', parseFloat(monto) || 0,
        fecha || new Date().toISOString().slice(0, 10), vencimiento || null, estado || 'pagado', archivo || null])
    return id
  },

  async obtener(id) { return (await query(`SELECT * FROM gastos_vehiculo WHERE id = ?`, [id])).rows[0] },

  async eliminar(id) {
    const g = await this.obtener(id)
    await query(`DELETE FROM gastos_vehiculo WHERE id = ?`, [id])
    return g ? g.archivo : null
  },

  async resumen(id_vehiculo, { desde, hasta } = {}) {
    const wheres = ['id_vehiculo = ?']
    const params = [id_vehiculo]
    if (desde) { wheres.push('fecha >= ?'); params.push(desde) }
    if (hasta) { wheres.push('fecha <= ?'); params.push(hasta) }
    const rows = (await query(`SELECT categoria, COALESCE(SUM(monto),0) AS total FROM gastos_vehiculo WHERE ${wheres.join(' AND ')} GROUP BY categoria`, params)).rows
    const porCategoria = {}
    let total = 0
    rows.forEach(r => { porCategoria[r.categoria] = r.total; total += r.total })
    return { porCategoria, total }
  },
}

module.exports = GastosVehiculoModel
