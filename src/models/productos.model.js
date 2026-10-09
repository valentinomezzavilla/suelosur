'use strict'
const { query, transaction } = require('../config/db')
const { UNIDAD_CONTENEDOR } = require('../utils/contenedor')

// Un contenedor se cobra por unidad (precio cantera / viaje por contenedor), con unidad
// fija y sin control de stock (se alquila y vuelve).
function valoresProducto({ nombre, unidad_medida, precio_cantera, precio_viaje, es_contenedor, depende_stock }) {
  const esCont = !!es_contenedor
  return [
    nombre,
    esCont ? UNIDAD_CONTENEDOR : (unidad_medida || 'm³'),
    parseFloat(precio_cantera) || 0,
    parseFloat(precio_viaje) || 0,
    esCont ? 1 : 0,
    esCont || depende_stock === false ? 0 : 1,
  ]
}

const ProductosModel = {

  async listar() {
    // Disponible real = lo que hay en planta menos lo ya comprometido en pedidos.
    // LEFT JOIN porque un producto puede no tener fila de stock todavía.
    return (await query(`
      SELECT p.*,
             (COALESCE(s.cantidad_actual, 0) - COALESCE(s.cant_pendiente_entregar, 0)) AS disponible_real
      FROM productos p
      LEFT JOIN stock s ON s.id_producto = p.id
      ORDER BY p.nombre
    `)).rows
  },

  async listarActivos() {
    return (await query(`
      SELECT p.id, p.nombre, p.unidad_medida, p.precio_cantera, p.precio_viaje, p.es_contenedor,
             (COALESCE(s.cantidad_actual,0) - COALESCE(s.cant_pendiente_entregar,0)) AS disponible_real
      FROM productos p LEFT JOIN stock s ON s.id_producto = p.id
      WHERE p.activo = 1 ORDER BY p.nombre
    `)).rows
  },

  async obtener(id) {
    return (await query(`SELECT * FROM productos WHERE id = ?`, [id])).rows[0]
  },

  async crear(datos) {
    const valores = valoresProducto(datos)
    return await transaction(async (q) => {
      const { rows } = await q(`INSERT INTO productos (nombre, unidad_medida, precio_cantera, precio_viaje, es_contenedor, depende_stock)
                                VALUES (?, ?, ?, ?, ?, ?) RETURNING id`, valores)
      const id = rows[0].id
      // Inicializar stock automáticamente
      await q(`INSERT INTO stock (id_producto) VALUES (?)`, [id])
      return id
    })
  },

  async actualizar(id, datos) {
    await query(`UPDATE productos SET nombre = ?, unidad_medida = ?, precio_cantera = ?, precio_viaje = ?, es_contenedor = ?, depende_stock = ? WHERE id = ?`,
      [...valoresProducto(datos), id])
  },

  async toggleActivo(id) {
    await query(`UPDATE productos SET activo = 1 - activo WHERE id = ?`, [id])
  },
}

module.exports = ProductosModel
