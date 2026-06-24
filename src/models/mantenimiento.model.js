'use strict'
// Mantenimiento de vehículos (preventivo/correctivo) + reglas por km/fecha.
const crypto = require('crypto')
const { query, transaction } = require('../config/db')

const MantenimientoModel = {

  async listar(id_vehiculo, { desde, hasta } = {}) {
    const wheres = ['id_vehiculo = ?']
    const params = [id_vehiculo]
    if (desde) { wheres.push('fecha >= ?'); params.push(desde) }
    if (hasta) { wheres.push('fecha <= ?'); params.push(hasta) }
    return (await query(`SELECT * FROM mantenimiento_vehiculo WHERE ${wheres.join(' AND ')} ORDER BY fecha DESC`, params)).rows
  },

  async crear({ id_vehiculo, categoria, tipo_service, fecha, costo, km, proxima_fecha, proximo_km, taller, descripcion, observaciones, archivo }) {
    const id = crypto.randomUUID()
    await transaction(async (q) => {
      await q(`
        INSERT INTO mantenimiento_vehiculo
          (id, id_vehiculo, categoria, tipo_service, fecha, costo, km, proxima_fecha, proximo_km, taller, descripcion, observaciones, archivo)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [id, id_vehiculo, categoria || 'preventivo', tipo_service || 'preventivo',
          fecha || new Date().toISOString().slice(0, 10), parseFloat(costo) || 0,
          parseInt(km) || 0, proxima_fecha || null, proximo_km ? parseInt(proximo_km) : null,
          taller || '', descripcion || '', observaciones || '', archivo || null])
      const k = parseInt(km) || 0
      if (k) await q(`UPDATE flota_vehiculos SET kilometraje = GREATEST(kilometraje, ?) WHERE id = ?`, [k, id_vehiculo])
    })
    return id
  },

  async obtener(id) { return (await query(`SELECT * FROM mantenimiento_vehiculo WHERE id = ?`, [id])).rows[0] },

  async eliminar(id) {
    const m = await this.obtener(id)
    await query(`DELETE FROM mantenimiento_vehiculo WHERE id = ?`, [id])
    return m ? m.archivo : null
  },

  async resumen(id_vehiculo, { desde, hasta } = {}) {
    const wheres = ['id_vehiculo = ?']
    const params = [id_vehiculo]
    if (desde) { wheres.push('fecha >= ?'); params.push(desde) }
    if (hasta) { wheres.push('fecha <= ?'); params.push(hasta) }
    return (await query(`
      SELECT COUNT(*) AS n, COALESCE(SUM(costo),0) AS costo,
             COALESCE(SUM(CASE WHEN categoria='preventivo' THEN 1 ELSE 0 END),0) AS preventivos,
             COALESCE(SUM(CASE WHEN categoria='correctivo' THEN 1 ELSE 0 END),0) AS correctivos
      FROM mantenimiento_vehiculo WHERE ${wheres.join(' AND ')}
    `, params)).rows[0]
  },

  // ── Reglas de mantenimiento (config_mantenimiento) ────────────
  async reglas(id_vehiculo) {
    return (await query(`SELECT * FROM config_mantenimiento WHERE id_vehiculo = ? OR id_vehiculo IS NULL ORDER BY id_vehiculo IS NULL, created_at DESC`, [id_vehiculo])).rows
  },

  async crearRegla({ id_vehiculo, tipo, cada_km, cada_meses, descripcion }) {
    const id = crypto.randomUUID()
    await query(`INSERT INTO config_mantenimiento (id, id_vehiculo, tipo, cada_km, cada_meses, descripcion) VALUES (?, ?, ?, ?, ?, ?)`,
      [id, id_vehiculo || null, tipo, cada_km ? parseInt(cada_km) : null, cada_meses ? parseInt(cada_meses) : null, descripcion || ''])
    return id
  },

  async eliminarRegla(id) { await query(`DELETE FROM config_mantenimiento WHERE id = ?`, [id]) },
}

module.exports = MantenimientoModel
