'use strict'
// Recursos (camión + chofer) asociados a una operación (op_encabezado).
const { query } = require('../config/db')
const { registrarAuditoria } = require('../utils/auditoria')
const { validarAsignacionOperacion } = require('../utils/compatibilidad')
const AsignacionesModel = require('./asignaciones.model')

const VENTANA_SOLAPE_MIN = 30 // minutos: advertir si hay otra op del mismo recurso dentro de este rango

const OperacionesModel = {

  async obtenerRecursos(opId) {
    return (await query(`
      SELECT op.id_chofer, op.id_camion, op.asignacion_fecha, op.asignacion_usuario, op.estado,
             (e.nombre || ' ' || COALESCE(e.apellido,'')) AS chofer_nombre,
             (COALESCE(v.nombre,'') || CASE WHEN v.patente IS NOT NULL THEN ' (' || v.patente || ')' ELSE '' END) AS camion_label,
             u.nombre AS asignado_por
      FROM op_encabezado op
      LEFT JOIN empleados e ON e.id = op.id_chofer
      LEFT JOIN flota_vehiculos v ON v.id = op.id_camion
      LEFT JOIN users u ON u.id = op.asignacion_usuario
      WHERE op.id = ?
    `, [opId])).rows[0]
  },

  // Operaciones del mismo camión/chofer dentro de ±VENTANA_SOLAPE_MIN el mismo día.
  async conflictosHorario({ idCamion, idChofer, fecha, hora, excludeOpId }) {
    if ((!idCamion && !idChofer) || !fecha || !hora) return []
    return (await query(`
      SELECT o.id, o.nro_op, o.hora_planificada, o.tipo_op, v.patente,
             (e.nombre || ' ' || COALESCE(e.apellido,'')) AS chofer
      FROM op_encabezado o
      LEFT JOIN flota_vehiculos v ON v.id = o.id_camion
      LEFT JOIN empleados e ON e.id = o.id_chofer
      WHERE o.id <> ? AND o.estado NOT IN ('anulado','entregado')
        AND o.fecha_entrega_planificada = ?
        AND o.hora_planificada IS NOT NULL AND o.hora_planificada <> ''
        AND (o.id_camion = ? OR o.id_chofer = ?)
        AND ABS(EXTRACT(EPOCH FROM (o.hora_planificada::time - ?::time))) <= ${VENTANA_SOLAPE_MIN * 60}
      ORDER BY o.hora_planificada
    `, [excludeOpId || 0, fecha, idCamion || null, idChofer || null, hora])).rows
  },

  async asignar(opId, { id_chofer, id_camion, usuario }) {
    // Si se asigna un chofer sin especificar camión, usar el camión que ya tiene asignado.
    if (id_chofer && !id_camion) {
      const asign = await AsignacionesModel.recursoActivo(id_chofer, 'camion')
      if (asign) id_camion = asign.recurso_id
    }
    // Validar compatibilidad chofer/unidad ↔ tipo de operación (bloqueante)
    if (id_chofer) {
      const op = (await query(`SELECT tipo_op, modalidad FROM op_encabezado WHERE id = ?`, [opId])).rows[0]
      const chofer = (await query(`SELECT nombre, apellido, tipo_operacion FROM empleados WHERE id = ?`, [id_chofer])).rows[0]
      const unidad = id_camion ? (await query(`SELECT actividad FROM flota_vehiculos WHERE id = ?`, [id_camion])).rows[0] : null
      const v = validarAsignacionOperacion({ chofer, op, unidad })
      if (!v.ok) throw new Error(v.motivo)
    }
    await query(`
      UPDATE op_encabezado
      SET id_chofer = ?, id_camion = ?, asignacion_fecha = to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'), asignacion_usuario = ?
      WHERE id = ?
    `, [id_chofer || null, id_camion || null, usuario || null, opId])
    registrarAuditoria({
      entidad_tipo: 'operacion', entidad_id: opId, accion: 'modificar', usuario,
      detalle: { id_chofer, id_camion },
    })
    // Advertencia (no bloqueante) por solapamiento de horario del camión/chofer
    const advertencias = []
    const op = (await query(`SELECT fecha_entrega_planificada, hora_planificada FROM op_encabezado WHERE id = ?`, [opId])).rows[0]
    if (op && (id_camion || id_chofer)) {
      const conflictos = await this.conflictosHorario({
        idCamion: id_camion, idChofer: id_chofer,
        fecha: op.fecha_entrega_planificada, hora: op.hora_planificada, excludeOpId: opId,
      })
      for (const c of conflictos) {
        advertencias.push(`Solapamiento: la OP-${String(c.nro_op).padStart(4, '0')} usa el mismo camión/chofer a las ${c.hora_planificada} (dentro de ${VENTANA_SOLAPE_MIN} min).`)
      }
    }
    return { advertencias }
  },

  // Choferes activos (es_chofer) para asignar, con su camión asignado y si están ocupados
  async choferesDisponibles() {
    return (await query(`
      SELECT e.id, e.nombre, e.apellido, e.tipo_operacion, a.recurso_id AS camion_id,
             EXISTS(SELECT 1 FROM op_encabezado o WHERE o.id_chofer = e.id AND o.estado = 'despachado') AS ocupado
      FROM empleados e
      LEFT JOIN asignaciones_recurso a ON a.id_empleado = e.id AND a.recurso_tipo = 'camion' AND a.activo = 1
      WHERE e.activo = 1 AND e.es_chofer = 1 ORDER BY e.apellido, e.nombre
    `)).rows
  },

  async obtenerChofer(id) {
    return (await query(`
      SELECT e.id, e.nombre, e.apellido, a.recurso_id AS camion_id
      FROM empleados e
      LEFT JOIN asignaciones_recurso a ON a.id_empleado = e.id AND a.recurso_tipo = 'camion' AND a.activo = 1
      WHERE e.id = ?
    `, [id])).rows[0] || null
  },

  // Camiones operativos para asignar, filtrados por la actividad requerida (ventas/contenedores/maquinas).
  // Un camión con actividad distinta a la requerida NO aparece; los "Sin definir" aparecen siempre.
  async camionesDisponibles(actividad = null) {
    const filtro = actividad ? `AND (v.actividad IS NULL OR v.actividad = '' OR v.actividad = ?)` : ''
    const params = actividad ? [actividad] : []
    return (await query(`
      SELECT v.id, v.nombre, v.patente, v.marca, v.modelo, v.estado_operativo, v.actividad,
             a.id_empleado AS chofer_id,
             EXISTS(SELECT 1 FROM op_encabezado o WHERE o.id_camion = v.id AND o.estado = 'despachado') AS ocupado
      FROM flota_vehiculos v
      LEFT JOIN asignaciones_recurso a ON a.recurso_id = v.id AND a.recurso_tipo = 'camion' AND a.activo = 1
      WHERE v.activo = 1 AND v.estado_operativo NOT IN ('inactivo','fuera_servicio')
        ${filtro}
      ORDER BY v.nombre
    `, params)).rows
  },
}

module.exports = OperacionesModel
