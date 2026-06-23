'use strict'
// Gestión documental polimórfica (empleados y vehículos).
const crypto = require('crypto')
const db = require('../config/db')

const DocumentosModel = {

  listar(entidad_tipo, entidad_id) {
    return db.prepare(`
      SELECT * FROM documentos
      WHERE entidad_tipo = ? AND entidad_id = ?
      ORDER BY (fecha_vencimiento IS NULL), fecha_vencimiento ASC, created_at DESC
    `).all(entidad_tipo, entidad_id)
  },

  obtener(id) {
    return db.prepare(`SELECT * FROM documentos WHERE id = ?`).get(id)
  },

  crear({ entidad_tipo, entidad_id, tipo, descripcion, archivo, fecha_emision, fecha_vencimiento }) {
    const id = crypto.randomUUID()
    db.prepare(`
      INSERT INTO documentos (id, entidad_tipo, entidad_id, tipo, descripcion, archivo, fecha_emision, fecha_vencimiento)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, entidad_tipo, entidad_id, tipo, descripcion || '', archivo || null,
           fecha_emision || null, fecha_vencimiento || null)
    return id
  },

  // Devuelve el nombre de archivo borrado (para limpiar del disco), o null.
  eliminar(id) {
    const doc = this.obtener(id)
    db.prepare(`DELETE FROM documentos WHERE id = ?`).run(id)
    return doc ? doc.archivo : null
  },
}

module.exports = DocumentosModel
