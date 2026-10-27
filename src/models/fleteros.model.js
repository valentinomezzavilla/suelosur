'use strict'
// Fleteros — CRUD como proveedores. Las compras guardan el NOMBRE del fletero en
// egresos.fletero (texto), así que renombrar uno actualiza también sus compras.
const { query, transaction } = require('../config/db')

const limpiar = (s) => String(s || '').trim()

const FleterosModel = {
  // Solo activos (para el desplegable de las compras). Para el listado admin usar listarTodos.
  async listar() {
    return (await query(`SELECT * FROM fleteros WHERE activo = 1 ORDER BY nombre`)).rows
  },

  // Con la cantidad de compras / pagos y lo pagado de flete: en material, el costo final
  // del flete; en otras categorías con fletero, el monto del pago.
  async listarTodos({ q } = {}) {
    const term = limpiar(q) ? `%${limpiar(q)}%` : null
    return (await query(`
      SELECT f.*,
             (SELECT COUNT(*) FROM egresos e WHERE e.fletero = f.nombre) AS compras,
             (SELECT COALESCE(SUM(CASE WHEN e.categoria = 'material' THEN COALESCE(e.costo_final_flete, 0) ELSE e.monto END), 0)
                FROM egresos e WHERE e.fletero = f.nombre) AS total_flete
      FROM fleteros f
      ${term ? 'WHERE f.nombre ILIKE ? OR f.cuit ILIKE ? OR f.email ILIKE ? OR f.telefono ILIKE ?' : ''}
      ORDER BY f.activo DESC, f.nombre
    `, term ? [term, term, term, term] : [])).rows
  },

  async obtener(id) {
    return (await query(`SELECT * FROM fleteros WHERE id = ?`, [id])).rows[0]
  },

  // Otro fletero con el mismo nombre (sin distinguir mayúsculas), para no duplicar
  async buscarPorNombre(nombre, { exceptoId } = {}) {
    return (await query(`SELECT * FROM fleteros WHERE LOWER(nombre) = LOWER(?) AND id <> ?`,
      [limpiar(nombre), exceptoId || 0])).rows[0]
  },

  async crear({ nombre, cuit, domicilio, telefono, email }) {
    const { rows } = await query(`INSERT INTO fleteros (nombre, cuit, domicilio, telefono, email) VALUES (?, ?, ?, ?, ?) RETURNING id`,
      [limpiar(nombre), cuit || null, domicilio || null, telefono || null, email || null])
    return rows[0].id
  },

  // Si cambia el nombre, las compras que lo tenían pasan al nombre nuevo
  async actualizar(id, { nombre, cuit, domicilio, telefono, email }) {
    await transaction(async (q) => {
      const antes = (await q(`SELECT nombre FROM fleteros WHERE id = ?`, [id])).rows[0]
      if (!antes) return
      const nuevo = limpiar(nombre)
      await q(`UPDATE fleteros SET nombre = ?, cuit = ?, domicilio = ?, telefono = ?, email = ? WHERE id = ?`,
        [nuevo, cuit || null, domicilio || null, telefono || null, email || null, id])
      if (antes.nombre !== nuevo) await q(`UPDATE egresos SET fletero = ? WHERE fletero = ?`, [nuevo, antes.nombre])
    })
  },

  async toggleActivo(id) {
    await query(`UPDATE fleteros SET activo = 1 - activo WHERE id = ?`, [id])
  },

  // Nombre de fletero escrito en una compra: si ya existe (sin distinguir mayúsculas) se
  // usa como está guardado; si no, se da de alta. Devuelve el nombre a guardar (o null).
  async asegurar(nombre, q = query) {
    const n = limpiar(nombre)
    if (!n) return null
    const existente = (await q(`SELECT nombre FROM fleteros WHERE LOWER(nombre) = LOWER(?) ORDER BY activo DESC, id LIMIT 1`, [n])).rows[0]
    if (existente) return existente.nombre
    await q(`INSERT INTO fleteros (nombre) VALUES (?)`, [n])
    return n
  },
}

module.exports = FleterosModel
