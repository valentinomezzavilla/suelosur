'use strict'
const { query, transaction } = require('../config/db')
const { UNIDAD_CONTENEDOR } = require('../utils/contenedor')

// Rangos de precio por día de los contenedores, agrupados por producto
async function rangosDe(idsProducto) {
  const ids = [...new Set(idsProducto.map(String))].filter(Boolean)
  const map = {}
  if (!ids.length) return map
  const rows = (await query(`
    SELECT id_producto, dias_desde, dias_hasta, precio_dia FROM producto_precios_dias
    WHERE id_producto = ANY(?) ORDER BY id_producto, dias_desde
  `, [ids])).rows
  rows.forEach(r => {
    const k = String(r.id_producto)
    ;(map[k] = map[k] || []).push({ dias_desde: r.dias_desde, dias_hasta: r.dias_hasta, precio_dia: Number(r.precio_dia) || 0 })
  })
  return map
}

// Les cuelga `rangos` a los productos que son contenedor
async function conRangos(productos) {
  const conts = productos.filter(p => p.es_contenedor)
  if (!conts.length) return productos
  const map = await rangosDe(conts.map(p => p.id))
  conts.forEach(p => { p.rangos = map[String(p.id)] || [] })
  return productos
}

// Guarda producto + rangos. Un contenedor tiene unidad "Días" y no usa los precios
// cantera/viaje (su precio sale de los rangos), así que quedan en cero.
async function guardarRangos(q, id, esContenedor, rangos) {
  await q(`DELETE FROM producto_precios_dias WHERE id_producto = ?`, [id])
  if (!esContenedor) return
  for (const r of rangos || []) {
    await q(`INSERT INTO producto_precios_dias (id_producto, dias_desde, dias_hasta, precio_dia) VALUES (?, ?, ?, ?)`,
      [id, r.dias_desde, r.dias_hasta, r.precio_dia])
  }
}

function valoresProducto({ nombre, unidad_medida, precio_cantera, precio_viaje, es_contenedor }) {
  const esCont = !!es_contenedor
  return {
    esCont,
    valores: [
      nombre,
      esCont ? UNIDAD_CONTENEDOR : (unidad_medida || 'm³'),
      esCont ? 0 : (parseFloat(precio_cantera) || 0),
      esCont ? 0 : (parseFloat(precio_viaje) || 0),
      esCont ? 1 : 0,
    ],
  }
}

const ProductosModel = {

  rangosDe,
  conRangos,

  async listar() {
    // Disponible real = lo que hay en planta menos lo ya comprometido en pedidos.
    // LEFT JOIN porque un producto puede no tener fila de stock todavía.
    return conRangos((await query(`
      SELECT p.*,
             (COALESCE(s.cantidad_actual, 0) - COALESCE(s.cant_pendiente_entregar, 0)) AS disponible_real
      FROM productos p
      LEFT JOIN stock s ON s.id_producto = p.id
      ORDER BY p.nombre
    `)).rows)
  },

  async listarActivos() {
    return conRangos((await query(`
      SELECT p.id, p.nombre, p.unidad_medida, p.precio_cantera, p.precio_viaje, p.es_contenedor,
             (COALESCE(s.cantidad_actual,0) - COALESCE(s.cant_pendiente_entregar,0)) AS disponible_real
      FROM productos p LEFT JOIN stock s ON s.id_producto = p.id
      WHERE p.activo = 1 ORDER BY p.nombre
    `)).rows)
  },

  async obtener(id) {
    const p = (await query(`SELECT * FROM productos WHERE id = ?`, [id])).rows[0]
    if (!p) return p
    p.rangos = (await rangosDe([p.id]))[String(p.id)] || []
    return p
  },

  async crear(datos) {
    const { esCont, valores } = valoresProducto(datos)
    return await transaction(async (q) => {
      const { rows } = await q(`INSERT INTO productos (nombre, unidad_medida, precio_cantera, precio_viaje, es_contenedor)
                                VALUES (?, ?, ?, ?, ?) RETURNING id`, valores)
      const id = rows[0].id
      // Inicializar stock automáticamente
      await q(`INSERT INTO stock (id_producto) VALUES (?)`, [id])
      await guardarRangos(q, id, esCont, datos.rangos)
      return id
    })
  },

  async actualizar(id, datos) {
    const { esCont, valores } = valoresProducto(datos)
    await transaction(async (q) => {
      await q(`UPDATE productos SET nombre = ?, unidad_medida = ?, precio_cantera = ?, precio_viaje = ?, es_contenedor = ? WHERE id = ?`,
        [...valores, id])
      await guardarRangos(q, id, esCont, datos.rangos)
    })
  },

  async toggleActivo(id) {
    await query(`UPDATE productos SET activo = 1 - activo WHERE id = ?`, [id])
  },
}

module.exports = ProductosModel
