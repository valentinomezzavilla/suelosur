'use strict'
const { query } = require('../config/db')

async function registrarAuditoria({ entidad_tipo, entidad_id, accion, usuario, detalle } = {}) {
  try {
    const det = detalle == null ? '' : (typeof detalle === 'string' ? detalle : JSON.stringify(detalle))
    await query(`
      INSERT INTO auditoria (entidad_tipo, entidad_id, accion, id_usuario, detalle)
      VALUES (?, ?, ?, ?, ?)
    `, [entidad_tipo, entidad_id, accion, usuario || null, det])
  } catch (err) {
    console.error('auditoria:', err.message)
  }
}

async function historial(entidad_tipo, entidad_id) {
  return (await query(`
    SELECT a.*, u.nombre AS usuario_nombre
    FROM auditoria a LEFT JOIN users u ON u.id = a.id_usuario
    WHERE a.entidad_tipo = ? AND a.entidad_id = ?
    ORDER BY a.created_at DESC
  `, [entidad_tipo, String(entidad_id)])).rows
}

module.exports = { registrarAuditoria, historial }
