'use strict'
// Mantenimiento de vehículos (preventivo/correctivo) + reglas por km/fecha.
const crypto = require('crypto')
const db = require('../config/db')

const MantenimientoModel = {

  listar(id_vehiculo, { desde, hasta } = {}) {
    const wheres = ['id_vehiculo = ?']
    const params = [id_vehiculo]
    if (desde) { wheres.push('fecha >= ?'); params.push(desde) }
    if (hasta) { wheres.push('fecha <= ?'); params.push(hasta) }
    return db.prepare(`SELECT * FROM mantenimiento_vehiculo WHERE ${wheres.join(' AND ')} ORDER BY fecha DESC`).all(...params)
  },

  crear({ id_vehiculo, categoria, tipo_service, fecha, costo, km, proxima_fecha, proximo_km, taller, descripcion, observaciones, archivo }) {
    const id = crypto.randomUUID()
    db.transaction(() => {
      db.prepare(`
        INSERT INTO mantenimiento_vehiculo
          (id, id_vehiculo, categoria, tipo_service, fecha, costo, km, proxima_fecha, proximo_km, taller, descripcion, observaciones, archivo)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, id_vehiculo, categoria || 'preventivo', tipo_service || 'preventivo',
             fecha || new Date().toISOString().slice(0, 10), parseFloat(costo) || 0,
             parseInt(km) || 0, proxima_fecha || null, proximo_km ? parseInt(proximo_km) : null,
             taller || '', descripcion || '', observaciones || '', archivo || null)
      const k = parseInt(km) || 0
      if (k) db.prepare(`UPDATE flota_vehiculos SET kilometraje = MAX(kilometraje, ?) WHERE id = ?`).run(k, id_vehiculo)
    })()
    return id
  },

  obtener(id) { return db.prepare(`SELECT * FROM mantenimiento_vehiculo WHERE id = ?`).get(id) },
  eliminar(id) {
    const m = this.obtener(id)
    db.prepare(`DELETE FROM mantenimiento_vehiculo WHERE id = ?`).run(id)
    return m ? m.archivo : null
  },

  resumen(id_vehiculo, { desde, hasta } = {}) {
    const wheres = ['id_vehiculo = ?']
    const params = [id_vehiculo]
    if (desde) { wheres.push('fecha >= ?'); params.push(desde) }
    if (hasta) { wheres.push('fecha <= ?'); params.push(hasta) }
    return db.prepare(`
      SELECT COUNT(*) AS n, COALESCE(SUM(costo),0) AS costo,
             COALESCE(SUM(CASE WHEN categoria='preventivo' THEN 1 ELSE 0 END),0) AS preventivos,
             COALESCE(SUM(CASE WHEN categoria='correctivo' THEN 1 ELSE 0 END),0) AS correctivos
      FROM mantenimiento_vehiculo WHERE ${wheres.join(' AND ')}
    `).get(...params)
  },

  // ── Reglas de mantenimiento (config_mantenimiento) ────────────
  reglas(id_vehiculo) {
    return db.prepare(`SELECT * FROM config_mantenimiento WHERE id_vehiculo = ? OR id_vehiculo IS NULL ORDER BY id_vehiculo IS NULL, created_at DESC`).all(id_vehiculo)
  },

  crearRegla({ id_vehiculo, tipo, cada_km, cada_meses, descripcion }) {
    const id = crypto.randomUUID()
    db.prepare(`INSERT INTO config_mantenimiento (id, id_vehiculo, tipo, cada_km, cada_meses, descripcion) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(id, id_vehiculo || null, tipo, cada_km ? parseInt(cada_km) : null, cada_meses ? parseInt(cada_meses) : null, descripcion || '')
    return id
  },

  eliminarRegla(id) { db.prepare(`DELETE FROM config_mantenimiento WHERE id = ?`).run(id) },
}

module.exports = MantenimientoModel
