'use strict'
// Recursos (camión + chofer) asociados a una operación (op_encabezado).
const db = require('../config/db')
const { registrarAuditoria } = require('../utils/auditoria')

const OperacionesModel = {

  obtenerRecursos(opId) {
    return db.prepare(`
      SELECT op.id_chofer, op.id_camion, op.asignacion_fecha, op.asignacion_usuario, op.estado,
             (e.nombre || ' ' || COALESCE(e.apellido,'')) AS chofer_nombre,
             (COALESCE(v.nombre,'') || CASE WHEN v.patente IS NOT NULL THEN ' (' || v.patente || ')' ELSE '' END) AS camion_label,
             u.nombre AS asignado_por
      FROM op_encabezado op
      LEFT JOIN empleados e ON e.id = op.id_chofer
      LEFT JOIN flota_vehiculos v ON v.id = op.id_camion
      LEFT JOIN users u ON u.id = op.asignacion_usuario
      WHERE op.id = ?
    `).get(opId)
  },

  asignar(opId, { id_chofer, id_camion, usuario }) {
    db.prepare(`
      UPDATE op_encabezado
      SET id_chofer = ?, id_camion = ?, asignacion_fecha = datetime('now'), asignacion_usuario = ?
      WHERE id = ?
    `).run(id_chofer || null, id_camion || null, usuario || null, opId)
    registrarAuditoria({
      entidad_tipo: 'operacion', entidad_id: opId, accion: 'modificar', usuario,
      detalle: { id_chofer, id_camion },
    })
  },

  // Choferes activos (es_chofer) para asignar
  choferesDisponibles() {
    return db.prepare(`
      SELECT id, nombre, apellido FROM empleados
      WHERE activo = 1 AND es_chofer = 1 ORDER BY apellido, nombre
    `).all()
  },

  // Camiones operativos para asignar
  camionesDisponibles() {
    return db.prepare(`
      SELECT id, nombre, patente, marca, modelo, estado_operativo FROM flota_vehiculos
      WHERE activo = 1 AND estado_operativo NOT IN ('inactivo','fuera_servicio')
      ORDER BY nombre
    `).all()
  },
}

module.exports = OperacionesModel
