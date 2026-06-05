'use strict'
const crypto = require('crypto')
const db = require('../config/db')

const ProductosModel = {

  listar() {
    return db.prepare(`SELECT * FROM productos ORDER BY nombre`).all()
  },

  listarActivos() {
    return db.prepare(`
      SELECT p.id, p.nombre, p.unidad_medida, p.precio_referencia,
             (COALESCE(s.cantidad_actual,0) - COALESCE(s.cant_pendiente_entregar,0)) AS disponible_real
      FROM productos p LEFT JOIN stock s ON s.id_producto = p.id
      WHERE p.activo = 1 ORDER BY p.nombre
    `).all()
  },

  obtener(id) {
    return db.prepare(`SELECT * FROM productos WHERE id = ?`).get(id)
  },

  crear({ nombre, unidad_medida, precio_referencia }) {
    const id = crypto.randomUUID()
    db.prepare(`INSERT INTO productos (id, nombre, unidad_medida, precio_referencia) VALUES (?, ?, ?, ?)`
    ).run(id, nombre, unidad_medida || 'm³', parseFloat(precio_referencia) || 0)
    // Inicializar stock automáticamente
    db.prepare(`INSERT INTO stock (id, id_producto) VALUES (?, ?)`).run(crypto.randomUUID(), id)
    return id
  },

  actualizar(id, { nombre, unidad_medida, precio_referencia }) {
    db.prepare(`UPDATE productos SET nombre = ?, unidad_medida = ?, precio_referencia = ? WHERE id = ?`
    ).run(nombre, unidad_medida || 'm³', parseFloat(precio_referencia) || 0, id)
  },

  toggleActivo(id) {
    db.prepare(`UPDATE productos SET activo = NOT activo WHERE id = ?`).run(id)
  },
}

module.exports = ProductosModel
