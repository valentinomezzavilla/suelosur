'use strict'
// Proveedores — CRUD + búsqueda inteligente (razón social / CUIT).
const crypto = require('crypto')
const { query, transaction } = require('../config/db')

const ProveedoresModel = {
  // Solo activos (para selectores). Para el listado admin usar listarTodos.
  async listar() {
    return (await query(`SELECT * FROM proveedores WHERE activo = 1 ORDER BY nombre`)).rows
  },

  async listarTodos({ q } = {}) {
    if (q && String(q).trim()) {
      const term = `%${String(q).trim()}%`
      return (await query(`SELECT * FROM proveedores WHERE nombre ILIKE? OR cuit ILIKE? OR email ILIKE? ORDER BY activo DESC, nombre`, [term, term, term])).rows
    }
    return (await query(`SELECT * FROM proveedores ORDER BY activo DESC, nombre`)).rows
  },

  async obtener(id) {
    return (await query(`SELECT * FROM proveedores WHERE id = ?`, [id])).rows[0]
  },

  async crear({ nombre, cuit, domicilio, telefono, email }) {
    const id = crypto.randomUUID()
    await query(`INSERT INTO proveedores (id, nombre, cuit, domicilio, telefono, email) VALUES (?, ?, ?, ?, ?, ?)`,
      [id, nombre, cuit || null, domicilio || null, telefono || null, email || null])
    return id
  },

  async actualizar(id, { nombre, cuit, domicilio, telefono, email }) {
    await query(`UPDATE proveedores SET nombre = ?, cuit = ?, domicilio = ?, telefono = ?, email = ? WHERE id = ?`,
      [nombre, cuit || null, domicilio || null, telefono || null, email || null, id])
  },

  async toggleActivo(id) {
    await query(`UPDATE proveedores SET activo = 1 - activo WHERE id = ?`, [id])
  },

  // Cantidad de ingresos de stock asociados (para mostrar trazabilidad)
  async contarIngresos(id) {
    return (await query(`SELECT COUNT(*) AS n FROM stock_ingresos WHERE id_proveedor = ?`, [id])).rows[0]?.n || 0
  },

  async buscarLive(q, limit = 8) {
    const s = String(q || '').trim()
    if (!s) return []
    const term = `%${s}%`
    return (await query(`
      SELECT * FROM proveedores
      WHERE activo = 1 AND (nombre ILIKE? OR cuit ILIKE?)
      ORDER BY nombre LIMIT ?
    `, [term, term, limit])).rows
  },
}

module.exports = ProveedoresModel
