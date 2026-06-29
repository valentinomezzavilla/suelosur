'use strict'
const { query, transaction } = require('../config/db')

const StockModel = {

  async listar() {
    return (await query(`
      SELECT p.id, p.nombre, p.unidad_medida, p.precio_referencia,
             COALESCE(s.cantidad_actual, 0)         AS cantidad_actual,
             COALESCE(s.cant_pendiente_entregar, 0) AS cant_pendiente_entregar,
             COALESCE(s.stock_minimo, 0)             AS stock_minimo,
             (COALESCE(s.cantidad_actual, 0) - COALESCE(s.cant_pendiente_entregar, 0)) AS disponible_real
      FROM productos p LEFT JOIN stock s ON s.id_producto = p.id
      WHERE p.activo = 1 ORDER BY p.nombre
    `)).rows
  },

  async obtener(id_producto) {
    return (await query(`
      SELECT p.id, p.nombre, p.unidad_medida,
             COALESCE(s.cantidad_actual, 0) AS cantidad_actual
      FROM productos p LEFT JOIN stock s ON s.id_producto = p.id WHERE p.id = ?
    `, [id_producto])).rows[0]
  },

  async ajustar(id_producto, { cantidad_actual, stock_minimo }) {
    await query(`UPDATE stock SET cantidad_actual = ?, stock_minimo = ? WHERE id_producto = ?`,
      [cantidad_actual, stock_minimo, id_producto])
  },

  async registrarIngreso(id_producto, cantidad, { id_proveedor, costo_unitario, usuario, observaciones } = {}) {
    await transaction(async (q) => {
      await q(`UPDATE stock SET cantidad_actual = cantidad_actual + ? WHERE id_producto = ?`, [cantidad, id_producto])
      await q(`
        INSERT INTO stock_ingresos (id_producto, id_proveedor, cantidad, costo_unitario, id_usuario, observaciones)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [id_producto, id_proveedor || null, cantidad,
          parseFloat(costo_unitario) || 0, usuario || null, observaciones || ''])
    })
  },

  async ingresos(id_producto) {
    return (await query(`
      SELECT si.*, pr.nombre AS proveedor_nombre
      FROM stock_ingresos si LEFT JOIN proveedores pr ON pr.id = si.id_proveedor
      WHERE si.id_producto = ? ORDER BY si.fecha DESC, si.created_at DESC
    `, [id_producto])).rows
  },

  async registrarEgreso(id_producto, cantidad) {
    await query(`UPDATE stock SET cantidad_actual = GREATEST(0, cantidad_actual - ?) WHERE id_producto = ?`,
      [cantidad, id_producto])
  },

  async sumarPendiente(id_producto, cantidad) {
    await query(`UPDATE stock SET cant_pendiente_entregar = cant_pendiente_entregar + ? WHERE id_producto = ?`,
      [cantidad, id_producto])
  },

  async restarPendiente(id_producto, cantidad) {
    await query(`UPDATE stock SET cant_pendiente_entregar = GREATEST(0, cant_pendiente_entregar - ?) WHERE id_producto = ?`,
      [cantidad, id_producto])
  },

  async descontarEntrega(id_producto, cantidad) {
    await query(`
      UPDATE stock SET
        cantidad_actual         = GREATEST(0, cantidad_actual - ?),
        cant_pendiente_entregar = GREATEST(0, cant_pendiente_entregar - ?)
      WHERE id_producto = ?
    `, [cantidad, cantidad, id_producto])
  },
}

module.exports = StockModel
