'use strict'
// Proveedores — CRUD + búsqueda inteligente (razón social / CUIT).
const crypto = require('crypto')
const db = require('../config/db')

const ProveedoresModel = {
  // Solo activos (para selectores). Para el listado admin usar listarTodos.
  listar() {
    return db.prepare(`SELECT * FROM proveedores WHERE activo = 1 ORDER BY nombre`).all()
  },

  listarTodos({ q } = {}) {
    if (q && String(q).trim()) {
      const term = `%${String(q).trim()}%`
      return db.prepare(`SELECT * FROM proveedores WHERE nombre LIKE ? OR cuit LIKE ? OR email LIKE ? ORDER BY activo DESC, nombre`).all(term, term, term)
    }
    return db.prepare(`SELECT * FROM proveedores ORDER BY activo DESC, nombre`).all()
  },

  obtener(id) {
    return db.prepare(`SELECT * FROM proveedores WHERE id = ?`).get(id)
  },

  crear({ nombre, cuit, domicilio, telefono, email }) {
    const id = crypto.randomUUID()
    db.prepare(`INSERT INTO proveedores (id, nombre, cuit, domicilio, telefono, email) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(id, nombre, cuit || null, domicilio || null, telefono || null, email || null)
    return id
  },

  actualizar(id, { nombre, cuit, domicilio, telefono, email }) {
    db.prepare(`UPDATE proveedores SET nombre = ?, cuit = ?, domicilio = ?, telefono = ?, email = ? WHERE id = ?`)
      .run(nombre, cuit || null, domicilio || null, telefono || null, email || null, id)
  },

  toggleActivo(id) {
    db.prepare(`UPDATE proveedores SET activo = NOT activo WHERE id = ?`).run(id)
  },

  // Cantidad de ingresos de stock asociados (para mostrar trazabilidad)
  contarIngresos(id) {
    return db.prepare(`SELECT COUNT(*) AS n FROM stock_ingresos WHERE id_proveedor = ?`).get(id).n
  },

  buscarLive(q, limit = 8) {
    const s = String(q || '').trim()
    if (!s) return []
    const term = `%${s}%`
    return db.prepare(`
      SELECT * FROM proveedores
      WHERE activo = 1 AND (nombre LIKE ? OR cuit LIKE ?)
      ORDER BY nombre LIMIT ?
    `).all(term, term, limit)
  },
}

module.exports = ProveedoresModel
