'use strict'
// Compras / abastecimiento — historial de ingresos de stock con proveedor.
const { query } = require('../config/db')

const ComprasModel = {

  async listar({ proveedor, producto, fechaDesde, fechaHasta } = {}) {
    const wheres = ['1=1']
    const params = []
    if (proveedor)  { wheres.push('si.id_proveedor = ?'); params.push(proveedor) }
    if (producto)   { wheres.push('si.id_producto = ?');  params.push(producto) }
    if (fechaDesde) { wheres.push('si.fecha >= ?');       params.push(fechaDesde) }
    if (fechaHasta) { wheres.push('si.fecha <= ?');       params.push(fechaHasta) }
    return (await query(`
      SELECT si.*, p.nombre AS producto_nombre, p.unidad_medida,
             pr.nombre AS proveedor_nombre, u.nombre AS usuario_nombre,
             (si.cantidad * si.costo_unitario) AS total
      FROM stock_ingresos si
      JOIN productos p ON p.id = si.id_producto
      LEFT JOIN proveedores pr ON pr.id = si.id_proveedor
      LEFT JOIN users u ON u.id = si.id_usuario
      WHERE ${wheres.join(' AND ')}
      ORDER BY si.fecha DESC, si.created_at DESC
    `, params)).rows
  },

  async resumen({ proveedor, producto, fechaDesde, fechaHasta } = {}) {
    const wheres = ['1=1']
    const params = []
    if (proveedor)  { wheres.push('id_proveedor = ?'); params.push(proveedor) }
    if (producto)   { wheres.push('id_producto = ?');  params.push(producto) }
    if (fechaDesde) { wheres.push('fecha >= ?');       params.push(fechaDesde) }
    if (fechaHasta) { wheres.push('fecha <= ?');       params.push(fechaHasta) }
    const r = (await query(`
      SELECT COUNT(*) AS count, COALESCE(SUM(cantidad),0) AS cantidad,
             COALESCE(SUM(cantidad * costo_unitario),0) AS total
      FROM stock_ingresos WHERE ${wheres.join(' AND ')}
    `, params)).rows[0]
    return r
  },
}

module.exports = ComprasModel
