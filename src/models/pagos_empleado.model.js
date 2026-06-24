'use strict'
// Pagos a empleados: sueldos, anticipos, viáticos, HE, bonif., descuentos, liquidaciones.
const crypto = require('crypto')
const { query } = require('../config/db')

// Tipos que restan (descuento) — el resto suma al neto pagado.
const RESTAN = new Set(['descuento'])

const PagosEmpleadoModel = {

  async listar(id_empleado, { desde, hasta, tipo } = {}) {
    const wheres = ['id_empleado = ?']
    const params = [id_empleado]
    if (desde) { wheres.push('fecha >= ?'); params.push(desde) }
    if (hasta) { wheres.push('fecha <= ?'); params.push(hasta) }
    if (tipo)  { wheres.push('tipo = ?');  params.push(tipo) }
    return (await query(`
      SELECT * FROM pagos_empleado WHERE ${wheres.join(' AND ')}
      ORDER BY fecha DESC, created_at DESC
    `, params)).rows
  },

  async crear({ id_empleado, tipo, periodo, monto, fecha, descripcion }) {
    const id = crypto.randomUUID()
    await query(`
      INSERT INTO pagos_empleado (id, id_empleado, tipo, periodo, monto, fecha, descripcion)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [id, id_empleado, tipo, periodo || null, parseFloat(monto) || 0,
        fecha || new Date().toISOString().slice(0, 10), descripcion || ''])
    return id
  },

  async eliminar(id) {
    await query(`DELETE FROM pagos_empleado WHERE id = ?`, [id])
  },

  async resumen(id_empleado, { desde, hasta } = {}) {
    const wheres = ['id_empleado = ?']
    const params = [id_empleado]
    if (desde) { wheres.push('fecha >= ?'); params.push(desde) }
    if (hasta) { wheres.push('fecha <= ?'); params.push(hasta) }
    const rows = (await query(`
      SELECT tipo, COALESCE(SUM(monto),0) AS total, COUNT(*) AS n
      FROM pagos_empleado WHERE ${wheres.join(' AND ')} GROUP BY tipo
    `, params)).rows
    const porTipo = {}
    let neto = 0
    rows.forEach(r => { porTipo[r.tipo] = r.total; neto += RESTAN.has(r.tipo) ? -r.total : r.total })
    return { porTipo, neto, count: rows.reduce((a, r) => a + r.n, 0) }
  },
}

module.exports = PagosEmpleadoModel
