'use strict'
// ═══════════════════════════════════════════════════════════════════
// egresos.model.js — Libro único de salidas de dinero (compras / pagos).
// Cada fila es un egreso categorizado (material, sueldo, seguro, etc.),
// vinculado opcionalmente a un proveedor / empleado / vehículo.
// ═══════════════════════════════════════════════════════════════════
const { query, transaction } = require('../config/db')

const CATEGORIAS = ['material', 'sueldo', 'seguro', 'proveedor', 'mantenimiento', 'combustible', 'impuesto', 'otro']

const EgresosModel = {

  CATEGORIAS,

  async crear({ fecha, categoria, descripcion, monto, metodo_pago, fletero, id_proveedor, id_empleado, id_vehiculo, origen, id_usuario }) {
    if (!CATEGORIAS.includes(categoria)) throw new Error('Categoría inválida.')
    const { rows } = await query(`
      INSERT INTO egresos (fecha, categoria, descripcion, monto, metodo_pago, fletero, id_proveedor, id_empleado, id_vehiculo, origen, id_usuario)
      VALUES (COALESCE(?, to_char(CURRENT_DATE, 'YYYY-MM-DD')), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING id
    `, [fecha || null, categoria, descripcion || '', parseFloat(monto) || 0, metodo_pago || null, (fletero || '').trim() || null,
        id_proveedor || null, id_empleado || null, id_vehiculo || null, origen || 'manual', id_usuario || null])
    return rows[0].id
  },

  async listar({ categoria, id_proveedor, fechaDesde, fechaHasta } = {}) {
    const wheres = []
    const params = []
    if (categoria)    { wheres.push('e.categoria = ?');    params.push(categoria) }
    if (id_proveedor) { wheres.push('e.id_proveedor = ?'); params.push(id_proveedor) }
    if (fechaDesde)   { wheres.push('e.fecha >= ?');       params.push(fechaDesde) }
    if (fechaHasta)   { wheres.push('e.fecha <= ?');       params.push(fechaHasta) }
    const where = wheres.length ? 'WHERE ' + wheres.join(' AND ') : ''
    return (await query(`
      SELECT e.*,
             p.nombre AS proveedor_nombre,
             NULLIF(TRIM(COALESCE(emp.nombre,'') || ' ' || COALESCE(emp.apellido,'')), '') AS empleado_nombre,
             NULLIF(TRIM(COALESCE(v.nombre,'') || CASE WHEN v.patente IS NOT NULL THEN ' (' || v.patente || ')' ELSE '' END), '') AS vehiculo_nombre,
             u.nombre AS usuario_nombre
      FROM egresos e
      LEFT JOIN proveedores p     ON p.id  = e.id_proveedor
      LEFT JOIN empleados emp     ON emp.id = e.id_empleado
      LEFT JOIN flota_vehiculos v ON v.id  = e.id_vehiculo
      LEFT JOIN users u           ON u.id  = e.id_usuario
      ${where}
      ORDER BY e.fecha DESC, e.id DESC
    `, params)).rows
  },

  async resumen({ categoria, id_proveedor, fechaDesde, fechaHasta } = {}) {
    const wheres = []
    const params = []
    if (categoria)    { wheres.push('categoria = ?');    params.push(categoria) }
    if (id_proveedor) { wheres.push('id_proveedor = ?'); params.push(id_proveedor) }
    if (fechaDesde)   { wheres.push('fecha >= ?');       params.push(fechaDesde) }
    if (fechaHasta)   { wheres.push('fecha <= ?');       params.push(fechaHasta) }
    const where = wheres.length ? 'WHERE ' + wheres.join(' AND ') : ''
    const rows = (await query(`SELECT categoria, COUNT(*) AS c, COALESCE(SUM(monto),0) AS s FROM egresos ${where} GROUP BY categoria`, params)).rows
    const porCategoria = {}
    let total = 0, count = 0
    rows.forEach(r => { porCategoria[r.categoria] = { monto: Number(r.s), count: Number(r.c) }; total += Number(r.s); count += Number(r.c) })
    return { total, count, porCategoria }
  },

  async obtener(id) {
    return (await query(`SELECT * FROM egresos WHERE id = ?`, [id])).rows[0]
  },

  // Si el egreso es el pago de un sueldo, también se borra ese pago de la ficha del
  // empleado (y su recibo), para que las dos listas no queden desalineadas.
  async eliminar(id) {
    await transaction(async (q) => {
      const e = (await q(`SELECT id, id_pago_empleado FROM egresos WHERE id = ?`, [id])).rows[0]
      if (!e) return
      await q(`DELETE FROM egresos WHERE id = ?`, [id])
      await q(`DELETE FROM pagos_empleado WHERE id_egreso = ? ${e.id_pago_empleado ? 'OR id = ?' : ''}`,
        e.id_pago_empleado ? [id, e.id_pago_empleado] : [id])
    })
  },
}

module.exports = EgresosModel
