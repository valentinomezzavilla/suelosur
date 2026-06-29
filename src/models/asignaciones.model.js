'use strict'
// Asignación polimórfica de recursos (camión / máquina) a choferes, con historial.
// Reglas de negocio:
//  - Un recurso sólo puede estar asignado activo a UN chofer a la vez.
//  - Un chofer puede tener a la vez 1 camión y/o 1 máquina (al reasignar se cierra la anterior).
//  - No se puede asignar un recurso en mantenimiento / fuera de servicio / inactivo.
const { query, transaction } = require('../config/db')

const NO_DISPONIBLE_CAMION = ['en_mantenimiento', 'fuera_servicio', 'inactivo']
const NO_DISPONIBLE_MAQ    = ['en_mantenimiento', 'fuera_servicio']

// Etiqueta legible de un recurso
async function labelRecurso(tipo, id) {
  if (tipo === 'camion') {
    const v = (await query(`SELECT numero_interno, patente, nombre FROM flota_vehiculos WHERE id = ?`, [id])).rows[0]
    if (!v) return '—'
    return [v.numero_interno ? '#' + v.numero_interno : null, v.patente, v.nombre].filter(Boolean).join(' · ')
  }
  const m = (await query(`SELECT numero_interno, nombre, tipo FROM maquinaria WHERE id = ?`, [id])).rows[0]
  if (!m) return '—'
  return [m.numero_interno ? '#' + m.numero_interno : null, m.nombre, m.tipo].filter(Boolean).join(' · ')
}

const AsignacionesModel = {

  // Asignaciones activas de un empleado (camión y/o máquina), con etiqueta
  async activas(empleadoId) {
    const rows = (await query(`SELECT * FROM asignaciones_recurso WHERE id_empleado = ? AND activo = 1 ORDER BY recurso_tipo`, [empleadoId])).rows
    return Promise.all(rows.map(async r => ({ ...r, recurso_label: await labelRecurso(r.recurso_tipo, r.recurso_id) })))
  },

  async recursoActivo(empleadoId, tipo) {
    const r = (await query(`SELECT * FROM asignaciones_recurso WHERE id_empleado = ? AND recurso_tipo = ? AND activo = 1 LIMIT 1`, [empleadoId, tipo])).rows[0]
    return r ? { ...r, recurso_label: await labelRecurso(r.recurso_tipo, r.recurso_id) } : null
  },

  // Historial de un empleado
  async historialEmpleado(empleadoId) {
    const rows = (await query(`SELECT * FROM asignaciones_recurso WHERE id_empleado = ? ORDER BY activo DESC, fecha_desde DESC`, [empleadoId])).rows
    return Promise.all(rows.map(async r => ({ ...r, recurso_label: await labelRecurso(r.recurso_tipo, r.recurso_id) })))
  },

  // Historial de un recurso (para la ficha del camión / máquina)
  async historialRecurso(tipo, recursoId) {
    return (await query(`
      SELECT a.*, (e.nombre || ' ' || COALESCE(e.apellido,'')) AS empleado_nombre, e.legajo
      FROM asignaciones_recurso a JOIN empleados e ON e.id = a.id_empleado
      WHERE a.recurso_tipo = ? AND a.recurso_id = ?
      ORDER BY a.activo DESC, a.fecha_desde DESC
    `, [tipo, recursoId])).rows
  },

  // Chofer que tiene asignado un recurso (activo), o null
  async choferDeRecurso(tipo, recursoId) {
    return (await query(`
      SELECT a.id_empleado, e.nombre, e.apellido, e.legajo
      FROM asignaciones_recurso a JOIN empleados e ON e.id = a.id_empleado
      WHERE a.recurso_tipo = ? AND a.recurso_id = ? AND a.activo = 1 LIMIT 1
    `, [tipo, recursoId])).rows[0]
  },

  async asignar({ id_empleado, recurso_tipo, recurso_id, observaciones }) {
    if (!['camion', 'maquina'].includes(recurso_tipo)) throw new Error('Tipo de recurso inválido.')
    if (!recurso_id) throw new Error('Seleccioná un recurso.')

    // Validar existencia + estado del recurso
    if (recurso_tipo === 'camion') {
      const v = (await query(`SELECT activo, estado_operativo FROM flota_vehiculos WHERE id = ?`, [recurso_id])).rows[0]
      if (!v) throw new Error('Camión no encontrado.')
      if (!v.activo) throw new Error('El camión está dado de baja.')
      if (NO_DISPONIBLE_CAMION.includes(v.estado_operativo)) throw new Error('El camión no está disponible (mantenimiento / fuera de servicio).')
    } else {
      const m = (await query(`SELECT activo, estado_operativo FROM maquinaria WHERE id = ?`, [recurso_id])).rows[0]
      if (!m) throw new Error('Máquina no encontrada.')
      if (!m.activo) throw new Error('La máquina está dada de baja.')
      if (NO_DISPONIBLE_MAQ.includes(m.estado_operativo)) throw new Error('La máquina no está disponible (mantenimiento / fuera de servicio).')
    }

    // No puede estar asignado activo a otro chofer (comparación numérica robusta)
    const ocupado = await this.choferDeRecurso(recurso_tipo, recurso_id)
    if (ocupado && Number(ocupado.id_empleado) !== Number(id_empleado)) {
      throw new Error(`Ya está asignado a ${ocupado.nombre} ${ocupado.apellido || ''}.`.trim())
    }
    // Si ya lo tiene este chofer, no duplicar
    if (ocupado && Number(ocupado.id_empleado) === Number(id_empleado)) {
      throw new Error('Este recurso ya está asignado a este chofer.')
    }

    return await transaction(async (q) => {
      // Reasignación: cerrar la asignación activa previa del mismo tipo para este chofer
      await q(`UPDATE asignaciones_recurso SET activo = 0, fecha_hasta = CURRENT_DATE
                  WHERE id_empleado = ? AND recurso_tipo = ? AND activo = 1`, [id_empleado, recurso_tipo])
      const { rows } = await q(`INSERT INTO asignaciones_recurso (id_empleado, recurso_tipo, recurso_id, observaciones) VALUES (?, ?, ?, ?) RETURNING id`,
        [id_empleado, recurso_tipo, recurso_id, observaciones || ''])
      return rows[0].id
    })
  },

  async finalizar(id) {
    await query(`UPDATE asignaciones_recurso SET activo = 0, fecha_hasta = CURRENT_DATE WHERE id = ?`, [id])
  },

  // Liberar todas las asignaciones activas de un empleado (al dar de baja / desactivar)
  async liberarEmpleado(empleadoId) {
    await query(`UPDATE asignaciones_recurso SET activo = 0, fecha_hasta = CURRENT_DATE WHERE id_empleado = ? AND activo = 1`, [empleadoId])
  },

  // Camiones disponibles: operativos y sin asignación activa
  async camionesDisponibles() {
    return (await query(`
      SELECT id, numero_interno, patente, nombre, marca, modelo, estado_operativo
      FROM flota_vehiculos v
      WHERE v.activo = 1 AND v.estado_operativo NOT IN ('en_mantenimiento','fuera_servicio','inactivo')
        AND NOT EXISTS (SELECT 1 FROM asignaciones_recurso a WHERE a.recurso_tipo='camion' AND a.recurso_id = v.id AND a.activo = 1)
      ORDER BY v.numero_interno, v.nombre
    `)).rows
  },

  // Máquinas disponibles: operativas y sin asignación activa
  async maquinasDisponibles() {
    return (await query(`
      SELECT id, numero_interno, nombre, tipo, marca, modelo, estado_operativo
      FROM maquinaria m
      WHERE m.activo = 1 AND m.estado_operativo NOT IN ('en_mantenimiento','fuera_servicio')
        AND NOT EXISTS (SELECT 1 FROM asignaciones_recurso a WHERE a.recurso_tipo='maquina' AND a.recurso_id = m.id AND a.activo = 1)
      ORDER BY m.numero_interno, m.nombre
    `)).rows
  },

  labelRecurso,
}

module.exports = AsignacionesModel
