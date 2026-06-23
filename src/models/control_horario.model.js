'use strict'
// Control horario / jornadas + horas extra.
const crypto = require('crypto')
const db = require('../config/db')

// Calcula horas entre HH:MM y HH:MM (maneja cruce de medianoche)
function horasEntre(ini, fin) {
  if (!ini || !fin) return 0
  const [h1, m1] = ini.split(':').map(Number)
  const [h2, m2] = fin.split(':').map(Number)
  let min = (h2 * 60 + m2) - (h1 * 60 + m1)
  if (min < 0) min += 24 * 60
  return Math.round((min / 60) * 100) / 100
}

const ControlHorarioModel = {

  listar(id_empleado, { desde, hasta } = {}) {
    const wheres = ['id_empleado = ?']
    const params = [id_empleado]
    if (desde) { wheres.push('fecha >= ?'); params.push(desde) }
    if (hasta) { wheres.push('fecha <= ?'); params.push(hasta) }
    return db.prepare(`
      SELECT c.*, u.nombre AS aprobador_nombre
      FROM control_horario c LEFT JOIN users u ON u.id = c.aprobado_por
      WHERE ${wheres.join(' AND ')}
      ORDER BY c.fecha DESC, c.created_at DESC
    `).all(...params)
  },

  crear({ id_empleado, fecha, hora_ingreso, hora_egreso, horas_extra, motivo_extra, observaciones }) {
    const id = crypto.randomUUID()
    const trabajadas = horasEntre(hora_ingreso, hora_egreso)
    const extra = parseFloat(horas_extra) || 0
    const normales = Math.max(0, trabajadas - extra)
    db.prepare(`
      INSERT INTO control_horario (id, id_empleado, fecha, hora_ingreso, hora_egreso, horas_normales, horas_extra, motivo_extra, observaciones)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, id_empleado, fecha || new Date().toISOString().slice(0, 10),
           hora_ingreso || null, hora_egreso || null, normales, extra,
           motivo_extra || '', observaciones || '')
    return id
  },

  aprobar(id, usuarioId) {
    db.prepare(`UPDATE control_horario SET aprobado = 1, aprobado_por = ? WHERE id = ?`).run(usuarioId, id)
  },

  eliminar(id) {
    db.prepare(`DELETE FROM control_horario WHERE id = ?`).run(id)
  },

  // Total de horas (normales + extra) en un período
  resumen(id_empleado, { desde, hasta } = {}) {
    const wheres = ['id_empleado = ?']
    const params = [id_empleado]
    if (desde) { wheres.push('fecha >= ?'); params.push(desde) }
    if (hasta) { wheres.push('fecha <= ?'); params.push(hasta) }
    const r = db.prepare(`
      SELECT COALESCE(SUM(horas_normales),0) AS normales,
             COALESCE(SUM(horas_extra),0) AS extra,
             COALESCE(SUM(CASE WHEN aprobado=1 THEN horas_extra ELSE 0 END),0) AS extra_aprobadas,
             COUNT(*) AS jornadas
      FROM control_horario WHERE ${wheres.join(' AND ')}
    `).get(...params)
    return r
  },
}

module.exports = ControlHorarioModel
