'use strict'
// ─────────────────────────────────────────────────────────────────
// Auditoría — registro inmutable de cambios (crear/modificar/baja/...).
// Uso: registrarAuditoria({ entidad_tipo, entidad_id, accion, usuario, detalle })
// ─────────────────────────────────────────────────────────────────
const crypto = require('crypto')
const db = require('../config/db')

function registrarAuditoria({ entidad_tipo, entidad_id, accion, usuario, detalle } = {}) {
  try {
    const det = detalle == null ? '' : (typeof detalle === 'string' ? detalle : JSON.stringify(detalle))
    db.prepare(`
      INSERT INTO auditoria (id, entidad_tipo, entidad_id, accion, id_usuario, detalle)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(crypto.randomUUID(), entidad_tipo, String(entidad_id), accion, usuario || null, det)
  } catch (err) {
    console.error('auditoria:', err.message) // nunca romper el flujo principal
  }
}

function historial(entidad_tipo, entidad_id) {
  return db.prepare(`
    SELECT a.*, u.nombre AS usuario_nombre
    FROM auditoria a LEFT JOIN users u ON u.id = a.id_usuario
    WHERE a.entidad_tipo = ? AND a.entidad_id = ?
    ORDER BY a.created_at DESC
  `).all(entidad_tipo, String(entidad_id))
}

module.exports = { registrarAuditoria, historial }
