'use strict'
// Gastos del vehículo: seguros, impuestos, peajes, estacionamientos, multas, otros.
const crypto = require('crypto')
const db = require('../config/db')

const GastosVehiculoModel = {

  listar(id_vehiculo, { desde, hasta, categoria } = {}) {
    const wheres = ['id_vehiculo = ?']
    const params = [id_vehiculo]
    if (desde) { wheres.push('fecha >= ?'); params.push(desde) }
    if (hasta) { wheres.push('fecha <= ?'); params.push(hasta) }
    if (categoria) { wheres.push('categoria = ?'); params.push(categoria) }
    return db.prepare(`SELECT * FROM gastos_vehiculo WHERE ${wheres.join(' AND ')} ORDER BY fecha DESC, created_at DESC`).all(...params)
  },

  crear({ id_vehiculo, categoria, descripcion, monto, fecha, vencimiento, estado, archivo }) {
    const id = crypto.randomUUID()
    db.prepare(`
      INSERT INTO gastos_vehiculo (id, id_vehiculo, categoria, descripcion, monto, fecha, vencimiento, estado, archivo)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, id_vehiculo, categoria, descripcion || '', parseFloat(monto) || 0,
           fecha || new Date().toISOString().slice(0, 10), vencimiento || null, estado || 'pagado', archivo || null)
    return id
  },

  obtener(id) { return db.prepare(`SELECT * FROM gastos_vehiculo WHERE id = ?`).get(id) },
  eliminar(id) {
    const g = this.obtener(id)
    db.prepare(`DELETE FROM gastos_vehiculo WHERE id = ?`).run(id)
    return g ? g.archivo : null
  },

  resumen(id_vehiculo, { desde, hasta } = {}) {
    const wheres = ['id_vehiculo = ?']
    const params = [id_vehiculo]
    if (desde) { wheres.push('fecha >= ?'); params.push(desde) }
    if (hasta) { wheres.push('fecha <= ?'); params.push(hasta) }
    const rows = db.prepare(`SELECT categoria, COALESCE(SUM(monto),0) AS total FROM gastos_vehiculo WHERE ${wheres.join(' AND ')} GROUP BY categoria`).all(...params)
    const porCategoria = {}
    let total = 0
    rows.forEach(r => { porCategoria[r.categoria] = r.total; total += r.total })
    return { porCategoria, total }
  },
}

module.exports = GastosVehiculoModel
