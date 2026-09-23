'use strict'
// ═══════════════════════════════════════════════════════════════════
// egresos.model.js — Libro único de salidas de dinero (compras / pagos).
// Cada fila es un egreso categorizado (material, sueldo, seguro, etc.),
// vinculado opcionalmente a un proveedor / empleado / vehículo.
// ═══════════════════════════════════════════════════════════════════
const { query, transaction } = require('../config/db')

// Filtros que se pueden combinar libremente desde el libro de compras / pagos.
// Las categorías son dinámicas (tabla categorias_egreso), acá no se validan.
// `periodo` filtra por el período propio del egreso, o el del pago de sueldo
// asociado cuando la categoría es 'sueldo' (join a pagos_empleado).
function construirFiltro({ categoria, id_proveedor, id_producto, id_empleado, id_vehiculo, metodo_pago, fletero, descripcion, periodo, fechaDesde, fechaHasta } = {}) {
  const wheres = []
  const params = []
  if (categoria)    { wheres.push('e.categoria = ?');                  params.push(categoria) }
  if (id_proveedor) { wheres.push('e.id_proveedor = ?');               params.push(id_proveedor) }
  if (id_producto)  { wheres.push('e.id_producto = ?');                params.push(id_producto) }
  if (id_empleado)  { wheres.push('e.id_empleado = ?');                params.push(id_empleado) }
  if (id_vehiculo)  { wheres.push('e.id_vehiculo = ?');                params.push(id_vehiculo) }
  if (metodo_pago)  { wheres.push('e.metodo_pago = ?');                params.push(metodo_pago) }
  if (fletero)      { wheres.push('e.fletero = ?');                    params.push(fletero) }
  if (descripcion)  { wheres.push('e.descripcion ILIKE ?');            params.push(`%${descripcion}%`) }
  if (periodo)      { wheres.push('COALESCE(e.periodo, pe.periodo) = ?'); params.push(periodo) }
  if (fechaDesde)   { wheres.push('e.fecha >= ?');                     params.push(fechaDesde) }
  if (fechaHasta)   { wheres.push('e.fecha <= ?');                     params.push(fechaHasta) }
  return { where: wheres.length ? 'WHERE ' + wheres.join(' AND ') : '', params }
}

const EgresosModel = {

  async crear({ fecha, categoria, descripcion, monto, metodo_pago, fletero, periodo, id_proveedor, id_producto, id_empleado, id_vehiculo, datos_extra, origen, id_usuario }) {
    if (!categoria) throw new Error('Elegí una categoría válida.')
    const { rows } = await query(`
      INSERT INTO egresos (fecha, categoria, descripcion, monto, metodo_pago, fletero, periodo, id_proveedor, id_producto, id_empleado, id_vehiculo, datos_extra, origen, id_usuario)
      VALUES (COALESCE(?, to_char(CURRENT_DATE, 'YYYY-MM-DD')), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING id
    `, [fecha || null, categoria, descripcion || '', parseFloat(monto) || 0, metodo_pago || null, (fletero || '').trim() || null,
        (periodo || '').trim() || null, id_proveedor || null, id_producto || null, id_empleado || null, id_vehiculo || null,
        JSON.stringify(datos_extra || {}), origen || 'manual', id_usuario || null])
    return rows[0].id
  },

  async listar(filtros = {}) {
    const { where, params } = construirFiltro(filtros)
    return (await query(`
      SELECT e.*,
             p.nombre AS proveedor_nombre,
             pr.nombre AS producto_nombre,
             NULLIF(TRIM(COALESCE(emp.nombre,'') || ' ' || COALESCE(emp.apellido,'')), '') AS empleado_nombre,
             NULLIF(TRIM(COALESCE(v.nombre,'') || CASE WHEN v.patente IS NOT NULL THEN ' (' || v.patente || ')' ELSE '' END), '') AS vehiculo_nombre,
             u.nombre AS usuario_nombre,
             COALESCE(e.periodo, pe.periodo) AS periodo
      FROM egresos e
      LEFT JOIN proveedores p     ON p.id  = e.id_proveedor
      LEFT JOIN productos pr      ON pr.id = e.id_producto
      LEFT JOIN empleados emp     ON emp.id = e.id_empleado
      LEFT JOIN flota_vehiculos v ON v.id  = e.id_vehiculo
      LEFT JOIN users u           ON u.id  = e.id_usuario
      LEFT JOIN pagos_empleado pe ON pe.id = e.id_pago_empleado
      ${where}
      ORDER BY e.fecha DESC, e.id DESC
    `, params)).rows
  },

  async resumen(filtros = {}) {
    const { where, params } = construirFiltro(filtros)
    const rows = (await query(`
      SELECT e.categoria, COUNT(*) AS c, COALESCE(SUM(e.monto),0) AS s
      FROM egresos e
      LEFT JOIN pagos_empleado pe ON pe.id = e.id_pago_empleado
      ${where}
      GROUP BY e.categoria
    `, params)).rows
    const porCategoria = {}
    let total = 0, count = 0
    rows.forEach(r => { porCategoria[r.categoria] = { monto: Number(r.s), count: Number(r.c) }; total += Number(r.s); count += Number(r.c) })
    return { total, count, porCategoria }
  },

  async obtener(id) {
    return (await query(`SELECT * FROM egresos WHERE id = ?`, [id])).rows[0]
  },

  // Fleteros ya cargados en alguna compra de material, para el desplegable del filtro.
  async fleteros() {
    const { rows } = await query(`
      SELECT DISTINCT fletero FROM egresos
      WHERE fletero IS NOT NULL AND fletero <> ''
      ORDER BY fletero
    `)
    return rows.map(r => r.fletero)
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
