'use strict'
const crypto = require('crypto')
const { query } = require('../config/db')

const ProductosModel = {

  async listar() {
    return (await query(`SELECT * FROM productos ORDER BY nombre`)).rows
  },

  async listarActivos() {
    return (await query(`
      SELECT p.id, p.nombre, p.unidad_medida, p.precio_referencia,
             (COALESCE(s.cantidad_actual,0) - COALESCE(s.cant_pendiente_entregar,0)) AS disponible_real
      FROM productos p LEFT JOIN stock s ON s.id_producto = p.id
      WHERE p.activo = 1 ORDER BY p.nombre
    `)).rows
  },

  async obtener(id) {
    return (await query(`SELECT * FROM productos WHERE id = ?`, [id])).rows[0]
  },

  async crear({ nombre, unidad_medida, precio_referencia }) {
    const id = crypto.randomUUID()
    await query(`INSERT INTO productos (id, nombre, unidad_medida, precio_referencia) VALUES (?, ?, ?, ?)`,
      [id, nombre, unidad_medida || 'm³', parseFloat(precio_referencia) || 0])
    // Inicializar stock automáticamente
    await query(`INSERT INTO stock (id, id_producto) VALUES (?, ?)`, [crypto.randomUUID(), id])
    return id
  },

  async actualizar(id, { nombre, unidad_medida, precio_referencia }) {
    await query(`UPDATE productos SET nombre = ?, unidad_medida = ?, precio_referencia = ? WHERE id = ?`,
      [nombre, unidad_medida || 'm³', parseFloat(precio_referencia) || 0, id])
  },

  async toggleActivo(id) {
    await query(`UPDATE productos SET activo = 1 - activo WHERE id = ?`, [id])
  },
}

module.exports = ProductosModel
