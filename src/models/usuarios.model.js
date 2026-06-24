'use strict'
const crypto = require('crypto')
const bcrypt = require('bcryptjs')
const { query, transaction } = require('../config/db')

const UsuariosModel = {

  async listar() {
    return (await query(`SELECT id, usuario, nombre, rol, activo, created_at FROM users ORDER BY nombre`)).rows
  },

  async obtener(id) {
    return (await query(`SELECT id, usuario, nombre, rol, activo FROM users WHERE id = ?`, [id])).rows[0]
  },

  async crear({ usuario, nombre, rol, password }) {
    const id = crypto.randomUUID()
    const hash = bcrypt.hashSync(password, 10)
    await query(`INSERT INTO users (id, usuario, password_hash, nombre, rol) VALUES (?, ?, ?, ?, ?)`,
      [id, usuario, hash, nombre, rol])
    return id
  },

  async actualizar(id, { usuario, nombre, rol, password }) {
    if (password) {
      const hash = bcrypt.hashSync(password, 10)
      await query(`UPDATE users SET usuario = ?, nombre = ?, rol = ?, password_hash = ? WHERE id = ?`,
        [usuario, nombre, rol, hash, id])
    } else {
      await query(`UPDATE users SET usuario = ?, nombre = ?, rol = ? WHERE id = ?`,
        [usuario, nombre, rol, id])
    }
  },

  async toggleActivo(id) {
    await query(`UPDATE users SET activo = 1 - activo WHERE id = ?`, [id])
  },

  async existeUsuario(usuario, excludeId = null) {
    if (excludeId) return (await query(`SELECT 1 FROM users WHERE usuario = ? AND id != ?`, [usuario, excludeId])).rows[0]
    return (await query(`SELECT 1 FROM users WHERE usuario = ?`, [usuario])).rows[0]
  },
}

module.exports = UsuariosModel
