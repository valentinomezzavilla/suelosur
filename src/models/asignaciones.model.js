'use strict'
// Asignación polimórfica de recursos (camión / máquina) a choferes, con historial.
// Reglas de negocio:
//  - Un recurso sólo puede estar asignado activo a UN chofer a la vez.
//  - Un chofer puede tener a la vez 1 camión y/o 1 máquina (al reasignar se cierra la anterior).
//  - No se puede asignar un recurso en mantenimiento / fuera de servicio / inactivo.
const crypto = require('crypto')
const db = require('../config/db')

const NO_DISPONIBLE_CAMION = ['en_mantenimiento', 'fuera_servicio', 'inactivo']
const NO_DISPONIBLE_MAQ    = ['en_mantenimiento', 'fuera_servicio']

// Etiqueta legible de un recurso
function labelRecurso(tipo, id) {
  if (tipo === 'camion') {
    const v = db.prepare(`SELECT numero_interno, patente, nombre FROM flota_vehiculos WHERE id = ?`).get(id)
    if (!v) return '—'
    return [v.numero_interno ? '#' + v.numero_interno : null, v.patente, v.nombre].filter(Boolean).join(' · ')
  }
  const m = db.prepare(`SELECT numero_interno, nombre, tipo FROM maquinaria WHERE id = ?`).get(id)
  if (!m) return '—'
  return [m.numero_interno ? '#' + m.numero_interno : null, m.nombre, m.tipo].filter(Boolean).join(' · ')
}

const AsignacionesModel = {

  // Asignaciones activas de un empleado (camión y/o máquina), con etiqueta
  activas(empleadoId) {
    const rows = db.prepare(`SELECT * FROM asignaciones_recurso WHERE id_empleado = ? AND activo = 1 ORDER BY recurso_tipo`).all(empleadoId)
    return rows.map(r => ({ ...r, recurso_label: labelRecurso(r.recurso_tipo, r.recurso_id) }))
  },

  recursoActivo(empleadoId, tipo) {
    const r = db.prepare(`SELECT * FROM asignaciones_recurso WHERE id_empleado = ? AND recurso_tipo = ? AND activo = 1 LIMIT 1`).get(empleadoId, tipo)
    return r ? { ...r, recurso_label: labelRecurso(r.recurso_tipo, r.recurso_id) } : null
  },

  // Historial de un empleado
  historialEmpleado(empleadoId) {
    return db.prepare(`SELECT * FROM asignaciones_recurso WHERE id_empleado = ? ORDER BY activo DESC, fecha_desde DESC`).all(empleadoId)
      .map(r => ({ ...r, recurso_label: labelRecurso(r.recurso_tipo, r.recurso_id) }))
  },

  // Historial de un recurso (para la ficha del camión / máquina)
  historialRecurso(tipo, recursoId) {
    return db.prepare(`
      SELECT a.*, (e.nombre || ' ' || COALESCE(e.apellido,'')) AS empleado_nombre, e.legajo
      FROM asignaciones_recurso a JOIN empleados e ON e.id = a.id_empleado
      WHERE a.recurso_tipo = ? AND a.recurso_id = ?
      ORDER BY a.activo DESC, a.fecha_desde DESC
    `).all(tipo, recursoId)
  },

  // Chofer que tiene asignado un recurso (activo), o null
  choferDeRecurso(tipo, recursoId) {
    return db.prepare(`
      SELECT a.id_empleado, e.nombre, e.apellido, e.legajo
      FROM asignaciones_recurso a JOIN empleados e ON e.id = a.id_empleado
      WHERE a.recurso_tipo = ? AND a.recurso_id = ? AND a.activo = 1 LIMIT 1
    `).get(tipo, recursoId)
  },

  asignar({ id_empleado, recurso_tipo, recurso_id, observaciones }) {
    if (!['camion', 'maquina'].includes(recurso_tipo)) throw new Error('Tipo de recurso inválido.')
    if (!recurso_id) throw new Error('Seleccioná un recurso.')

    // Validar existencia + estado del recurso
    if (recurso_tipo === 'camion') {
      const v = db.prepare(`SELECT activo, estado_operativo FROM flota_vehiculos WHERE id = ?`).get(recurso_id)
      if (!v) throw new Error('Camión no encontrado.')
      if (!v.activo) throw new Error('El camión está dado de baja.')
      if (NO_DISPONIBLE_CAMION.includes(v.estado_operativo)) throw new Error('El camión no está disponible (mantenimiento / fuera de servicio).')
    } else {
      const m = db.prepare(`SELECT activo, estado_operativo FROM maquinaria WHERE id = ?`).get(recurso_id)
      if (!m) throw new Error('Máquina no encontrada.')
      if (!m.activo) throw new Error('La máquina está dada de baja.')
      if (NO_DISPONIBLE_MAQ.includes(m.estado_operativo)) throw new Error('La máquina no está disponible (mantenimiento / fuera de servicio).')
    }

    // No puede estar asignado activo a otro chofer
    const ocupado = this.choferDeRecurso(recurso_tipo, recurso_id)
    if (ocupado && ocupado.id_empleado !== id_empleado) {
      throw new Error(`Ya está asignado a ${ocupado.nombre} ${ocupado.apellido || ''}.`.trim())
    }
    // Si ya lo tiene este chofer, no duplicar
    if (ocupado && ocupado.id_empleado === id_empleado) {
      throw new Error('Este recurso ya está asignado a este chofer.')
    }

    const id = crypto.randomUUID()
    db.transaction(() => {
      // Reasignación: cerrar la asignación activa previa del mismo tipo para este chofer
      db.prepare(`UPDATE asignaciones_recurso SET activo = 0, fecha_hasta = date('now')
                  WHERE id_empleado = ? AND recurso_tipo = ? AND activo = 1`).run(id_empleado, recurso_tipo)
      db.prepare(`INSERT INTO asignaciones_recurso (id, id_empleado, recurso_tipo, recurso_id, observaciones) VALUES (?, ?, ?, ?, ?)`)
        .run(id, id_empleado, recurso_tipo, recurso_id, observaciones || '')
    })()
    return id
  },

  finalizar(id) {
    db.prepare(`UPDATE asignaciones_recurso SET activo = 0, fecha_hasta = date('now') WHERE id = ?`).run(id)
  },

  // Liberar todas las asignaciones activas de un empleado (al dar de baja / desactivar)
  liberarEmpleado(empleadoId) {
    db.prepare(`UPDATE asignaciones_recurso SET activo = 0, fecha_hasta = date('now') WHERE id_empleado = ? AND activo = 1`).run(empleadoId)
  },

  // Camiones disponibles: operativos y sin asignación activa
  camionesDisponibles() {
    return db.prepare(`
      SELECT id, numero_interno, patente, nombre, marca, modelo, estado_operativo
      FROM flota_vehiculos v
      WHERE v.activo = 1 AND v.estado_operativo NOT IN ('en_mantenimiento','fuera_servicio','inactivo')
        AND NOT EXISTS (SELECT 1 FROM asignaciones_recurso a WHERE a.recurso_tipo='camion' AND a.recurso_id = v.id AND a.activo = 1)
      ORDER BY v.numero_interno, v.nombre
    `).all()
  },

  // Máquinas disponibles: operativas y sin asignación activa
  maquinasDisponibles() {
    return db.prepare(`
      SELECT id, numero_interno, nombre, tipo, marca, modelo, estado_operativo
      FROM maquinaria m
      WHERE m.activo = 1 AND m.estado_operativo NOT IN ('en_mantenimiento','fuera_servicio')
        AND NOT EXISTS (SELECT 1 FROM asignaciones_recurso a WHERE a.recurso_tipo='maquina' AND a.recurso_id = m.id AND a.activo = 1)
      ORDER BY m.numero_interno, m.nombre
    `).all()
  },

  labelRecurso,
}

module.exports = AsignacionesModel
