'use strict'
// Recursos (camión + chofer) asociados a una operación (op_encabezado).
const { query } = require('../config/db')
const { registrarAuditoria } = require('../utils/auditoria')
const { validarAsignacionOperacion } = require('../utils/compatibilidad')
const AsignacionesModel = require('./asignaciones.model')

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

  async asignar(opId, { id_chofer, id_camion, usuario }) {
    // Si se asigna un chofer sin especificar camión, usar el camión que ya tiene asignado.
    if (id_chofer && !id_camion) {
      const asign = await AsignacionesModel.recursoActivo(id_chofer, 'camion')
      if (asign) id_camion = asign.recurso_id
    }
    // Validar compatibilidad chofer/unidad ↔ tipo de operación
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
  },

  // Choferes activos (es_chofer) para asignar, con el camión que tienen asignado (si tienen)
  async choferesDisponibles() {
    return (await query(`
      SELECT e.id, e.nombre, e.apellido, a.recurso_id AS camion_id
      FROM empleados e
      LEFT JOIN asignaciones_recurso a ON a.id_empleado = e.id AND a.recurso_tipo = 'camion' AND a.activo = 1
      WHERE e.activo = 1 AND e.es_chofer = 1 ORDER BY e.apellido, e.nombre
    `)).rows
  },

  // Camiones operativos para asignar
  async camionesDisponibles() {
    return (await query(`
      SELECT id, nombre, patente, marca, modelo, estado_operativo, dedicacion FROM flota_vehiculos
      WHERE activo = 1 AND estado_operativo NOT IN ('inactivo','fuera_servicio')
      ORDER BY nombre
    `)).rows
  },
}

module.exports = OperacionesModel
