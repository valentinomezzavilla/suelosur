'use strict'
const crypto = require('crypto')
const bcrypt = require('bcryptjs')
const db = require('../config/db')

const UsuariosModel = {

  listar() {
    return db.prepare(`SELECT id, usuario, nombre, rol, activo, created_at FROM users ORDER BY nombre`).all()
  },

  obtener(id) {
    return db.prepare(`SELECT id, usuario, nombre, rol, activo FROM users WHERE id = ?`).get(id)
  },

  crear({ usuario, nombre, rol, password }) {
    const id = crypto.randomUUID()
    const hash = bcrypt.hashSync(password, 10)
    db.prepare(`INSERT INTO users (id, usuario, password_hash, nombre, rol) VALUES (?, ?, ?, ?, ?)`
    ).run(id, usuario, hash, nombre, rol)
    return id
  },

  actualizar(id, { usuario, nombre, rol, password }) {
    if (password) {
      const hash = bcrypt.hashSync(password, 10)
      db.prepare(`UPDATE users SET usuario = ?, nombre = ?, rol = ?, password_hash = ? WHERE id = ?`
      ).run(usuario, nombre, rol, hash, id)
    } else {
      db.prepare(`UPDATE users SET usuario = ?, nombre = ?, rol = ? WHERE id = ?`
      ).run(usuario, nombre, rol, id)
    }
  },

  toggleActivo(id) {
    db.prepare(`UPDATE users SET activo = NOT activo WHERE id = ?`).run(id)
  },

  existeUsuario(usuario, excludeId = null) {
    if (excludeId) return db.prepare(`SELECT 1 FROM users WHERE usuario = ? AND id != ?`).get(usuario, excludeId)
    return db.prepare(`SELECT 1 FROM users WHERE usuario = ?`).get(usuario)
  },
}

module.exports = UsuariosModel
