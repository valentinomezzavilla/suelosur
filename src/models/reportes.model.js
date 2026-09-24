'use strict'
// ═══════════════════════════════════════════════════════════════════
// reportes.model.js — Datos para el "Libro de ventas".
// Devuelve UN renglón por línea de venta: materiales (por producto),
// alquileres de contenedor y de maquinaria. Cada renglón trae fecha,
// remito, cantidad, material, código, cliente, obra, precio y importe.
// ═══════════════════════════════════════════════════════════════════
const { query } = require('../config/db')
const { codigoMaterial } = require('../utils/codigosMaterial')
const { importesVenta } = require('./ventas.model')
const { SQL_DESCRIPCION_DETALLE, SQL_UNIDAD_DETALLE } = require('../utils/contenedor')

// Fecha del renglón: la de entrega planificada; si falta, la de emisión.
const FECHA = `COALESCE(op.fecha_entrega_planificada, op.fecha_emision)`

const ReportesModel = {

  async libroVentas({ desde, hasta, clienteId } = {}) {
    const cond = [`op.estado <> 'anulado'`]
    const params = []
    if (clienteId) { cond.push('op.id_cliente = ?'); params.push(clienteId) }
    if (desde)     { cond.push(`${FECHA} >= ?`);     params.push(desde) }
    if (hasta)     { cond.push(`${FECHA} <= ?`);     params.push(hasta) }
    const where = cond.join(' AND ')

    // ── Materiales (ventas cantera / viaje) ──────────────────────
    const materiales = (await query(`
      SELECT ${FECHA} AS fecha, op.nro_remito, op.nro_op, op.obra,
             COALESCE(NULLIF(TRIM(COALESCE(c.nombre, '') || ' ' || COALESCE(c.apellido, '')), ''), 'Particular') AS cliente,
             ${SQL_DESCRIPCION_DETALLE} AS material, ${SQL_UNIDAD_DETALLE} AS unidad,
             d.cantidad_pedida AS cantidad, d.precio_unitario AS precio_unit,
             (d.cantidad_pedida * d.precio_unitario) AS importe
      FROM op_detalle_material d
      JOIN op_encabezado op ON op.id = d.id_orden_pedido
      JOIN productos p      ON p.id = d.id_producto
      LEFT JOIN clientes c  ON c.id = op.id_cliente
      WHERE ${where} AND op.tipo_op = 'M'
    `, params)).rows

    // ── Flete y ajuste del total pactado (el detalle solo tiene productos) ──
    const extras = []
    const ventas = (await query(`
      SELECT ${FECHA} AS fecha, op.nro_remito, op.nro_op, op.obra, op.precio_flete, op.monto_total,
             COALESCE(NULLIF(TRIM(COALESCE(c.nombre, '') || ' ' || COALESCE(c.apellido, '')), ''), 'Particular') AS cliente,
             (SELECT COALESCE(SUM(d.cantidad_pedida * d.precio_unitario), 0)
              FROM op_detalle_material d WHERE d.id_orden_pedido = op.id) AS subtotal
      FROM op_encabezado op
      LEFT JOIN clientes c ON c.id = op.id_cliente
      WHERE ${where} AND op.tipo_op = 'M' AND (op.precio_flete > 0 OR op.monto_total IS NOT NULL)
    `, params)).rows
    ventas.forEach(v => {
      const { flete, ajuste } = importesVenta(v, Number(v.subtotal) || 0)
      const base = { fecha: v.fecha, nro_remito: v.nro_remito, nro_op: v.nro_op, obra: v.obra, cliente: v.cliente, unidad: '', cantidad: 1 }
      if (flete)  extras.push({ ...base, material: 'Flete', precio_unit: flete, importe: flete })
      if (ajuste) extras.push({ ...base, material: 'Ajuste de precio', precio_unit: ajuste, importe: ajuste })
    })

    // ── Alquileres de contenedor ─────────────────────────────────
    const contenedores = (await query(`
      SELECT ${FECHA} AS fecha, op.nro_remito, op.nro_op, op.obra,
             COALESCE(NULLIF(TRIM(COALESCE(c.nombre, '') || ' ' || COALESCE(c.apellido, '')), ''), 'Particular') AS cliente,
             'Contenedor' AS material, '' AS unidad,
             1 AS cantidad, oc.precio_alquiler AS precio_unit, oc.precio_alquiler AS importe
      FROM op_detalle_contenedor oc
      JOIN op_encabezado op ON op.id = oc.id_orden_pedido
      LEFT JOIN clientes c  ON c.id = op.id_cliente
      WHERE ${where} AND op.tipo_op = 'C'
    `, params)).rows

    // ── Alquileres de maquinaria ─────────────────────────────────
    const maquinaria = (await query(`
      SELECT ${FECHA} AS fecha, op.nro_remito, op.nro_op, op.obra,
             COALESCE(NULLIF(TRIM(COALESCE(c.nombre, '') || ' ' || COALESCE(c.apellido, '')), ''), 'Particular') AS cliente,
             COALESCE(m.nombre, 'Maquinaria') AS material, 'h' AS unidad,
             dm.horas_pactadas AS cantidad, dm.precio_por_hora AS precio_unit, dm.precio_total AS importe
      FROM op_detalle_maquinaria dm
      JOIN op_encabezado op ON op.id = dm.id_orden_pedido
      LEFT JOIN maquinaria m ON m.id = dm.id_maquinaria
      LEFT JOIN clientes c   ON c.id = op.id_cliente
      WHERE ${where} AND op.tipo_op = 'MA'
    `, params)).rows

    const filas = [...materiales, ...extras, ...contenedores, ...maquinaria].map(f => ({
      fecha:       f.fecha,
      nro_remito:  f.nro_remito,
      nro_op:      f.nro_op,
      cantidad:    Number(f.cantidad || 0),
      unidad:      f.unidad || '',
      cod:         codigoMaterial(f.material),
      material:    f.material || '',
      cliente:     f.cliente || '',
      obra:        f.obra || '',
      precio_unit: Number(f.precio_unit || 0),
      importe:     Number(f.importe || 0),
    }))

    // Orden cronológico y por remito
    filas.sort((a, b) =>
      String(a.fecha || '').localeCompare(String(b.fecha || '')) ||
      (Number(a.nro_remito || 0) - Number(b.nro_remito || 0)))

    const total = filas.reduce((s, f) => s + f.importe, 0)
    return { filas, total }
  },
}

module.exports = ReportesModel
