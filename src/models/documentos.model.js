'use strict'
// Gestión documental polimórfica (empleados y vehículos).
const { query } = require('../config/db')

const DocumentosModel = {

  async listar(entidad_tipo, entidad_id) {
    return (await query(`
      SELECT * FROM documentos
      WHERE entidad_tipo = ? AND entidad_id = ?
      ORDER BY (fecha_vencimiento IS NULL), fecha_vencimiento ASC, created_at DESC
    `, [entidad_tipo, entidad_id])).rows
  },

  async obtener(id) {
    return (await query(`SELECT * FROM documentos WHERE id = ?`, [id])).rows[0]
  },

  async crear({ entidad_tipo, entidad_id, tipo, descripcion, archivo, fecha_emision, fecha_vencimiento, dias_alerta }) {
    const { rows } = await query(`
      INSERT INTO documentos (entidad_tipo, entidad_id, tipo, descripcion, archivo, fecha_emision, fecha_vencimiento, dias_alerta)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING id
    `, [entidad_tipo, entidad_id, tipo, descripcion || '', archivo || null,
        fecha_emision || null, fecha_vencimiento || null,
        (dias_alerta != null && dias_alerta !== '') ? parseInt(dias_alerta) : 30])
    return rows[0].id
  },

  // Devuelve el nombre de archivo borrado (para limpiar del disco), o null.
  async eliminar(id) {
    const doc = await this.obtener(id)
    await query(`DELETE FROM documentos WHERE id = ?`, [id])
    return doc ? doc.archivo : null
  },
}

module.exports = DocumentosModel
