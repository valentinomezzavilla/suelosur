'use strict'
// ═══════════════════════════════════════════════════════════════════
// Estaciones de servicio: proveedores con es_estacion = 1 y su cuenta (lo que se les debe).
//
//  · Debe (suma deuda): las cargas de combustible hechas en la estación
//    (combustible.id_proveedor) y los cargos manuales (cc_proveedores 'debito').
//  · Haber (baja deuda): todo egreso a nombre de la estación (egresos.id_proveedor) — los
//    pagos cargados en Compras / Pagos y las transferencias de clientes derivadas a ella
//    ("Destinado a tercero") — y los ajustes a favor (cc_proveedores 'credito').
//
// La cuenta no guarda saldos: se arma siempre desde esas tablas, así que borrar una carga,
// un pago o una transferencia corrige la deuda sola, sin nada que sincronizar.
// Saldo > 0: se le debe a la estación; < 0: quedó saldo a favor.
// ═══════════════════════════════════════════════════════════════════
const { query } = require('../config/db')

// Todos los movimientos de la cuenta, con la misma forma (fecha, debe, haber, origen)
const SQL_MOVIMIENTOS = `
  SELECT 'carga' AS origen, c.id, c.id_proveedor, c.fecha, c.created_at,
         'Carga de combustible' || COALESCE(' — ' || NULLIF(CONCAT_WS(' · ',
            NULLIF(CONCAT_WS(' ', CASE WHEN v.numero_interno IS NOT NULL THEN '#' || v.numero_interno END, v.patente), ''),
            CASE WHEN c.litros > 0 THEN ROUND(c.litros::numeric, 2) || ' l' END), ''), '') AS descripcion,
         COALESCE(c.costo_total, 0) AS debe, 0 AS haber, c.id_vehiculo, NULL::bigint AS id_transaccion, NULL::text AS metodo_pago
  FROM combustible c LEFT JOIN flota_vehiculos v ON v.id = c.id_vehiculo
  WHERE c.id_proveedor IS NOT NULL
  UNION ALL
  SELECT CASE WHEN m.tipo_movimiento = 'debito' THEN 'cargo' ELSE 'ajuste' END, m.id, m.id_proveedor, m.fecha, m.created_at,
         COALESCE(NULLIF(m.descripcion, ''), CASE WHEN m.tipo_movimiento = 'debito' THEN 'Cargo manual' ELSE 'Ajuste a favor' END),
         COALESCE(m.monto_debito, 0), COALESCE(m.monto_credito, 0), NULL, NULL, NULL
  FROM cc_proveedores m
  UNION ALL
  SELECT CASE WHEN e.origen = 'tercero' THEN 'transferencia' ELSE 'pago' END, e.id, e.id_proveedor, e.fecha, e.created_at,
         COALESCE(NULLIF(e.descripcion, ''), 'Pago'), 0, COALESCE(e.monto, 0), e.id_vehiculo, e.id_transaccion, e.metodo_pago
  FROM egresos e
  WHERE e.id_proveedor IS NOT NULL
`

const EstacionesModel = {
  // Activas, para los desplegables (carga de combustible, compras, transferencia a tercero)
  async listar() {
    return (await query(`SELECT * FROM proveedores WHERE activo = 1 AND es_estacion = 1 ORDER BY nombre`)).rows
  },

  async obtener(id) {
    return (await query(`SELECT * FROM proveedores WHERE id = ? AND es_estacion = 1`, [id])).rows[0]
  },

  // Las estaciones con su deuda total
  async resumen({ incluirInactivas = false } = {}) {
    return (await query(`
      SELECT p.id, p.nombre, p.cuit, p.telefono, p.activo,
             COALESCE(SUM(m.debe), 0) AS debe, COALESCE(SUM(m.haber), 0) AS haber,
             COALESCE(SUM(m.debe), 0) - COALESCE(SUM(m.haber), 0) AS saldo,
             MAX(m.fecha) AS ultimo_movimiento
      FROM proveedores p LEFT JOIN (${SQL_MOVIMIENTOS}) m ON m.id_proveedor = p.id
      WHERE p.es_estacion = 1 ${incluirInactivas ? '' : 'AND p.activo = 1'}
      GROUP BY p.id ORDER BY p.nombre
    `)).rows.map(r => ({ ...r, debe: Number(r.debe), haber: Number(r.haber), saldo: Number(r.saldo) }))
  },

  // Movimientos del período con el saldo corrido, más el saldo anterior al período
  async cuenta(id, { desde, hasta } = {}) {
    const todos = (await query(`
      SELECT * FROM (${SQL_MOVIMIENTOS}) m WHERE m.id_proveedor = ?
      ORDER BY m.fecha, m.created_at, m.origen, m.id
    `, [id])).rows.map(r => ({ ...r, debe: Number(r.debe), haber: Number(r.haber) }))
    let saldoAnterior = 0, saldo = 0
    const movimientos = []
    for (const m of todos) {
      const dia = String(m.fecha || '').slice(0, 10)
      if (hasta && dia > hasta) continue
      saldo += m.debe - m.haber
      if (desde && dia < desde) { saldoAnterior = saldo; continue }
      movimientos.push({ ...m, saldo })
    }
    const debe = movimientos.reduce((a, m) => a + m.debe, 0)
    const haber = movimientos.reduce((a, m) => a + m.haber, 0)
    return { movimientos, saldoAnterior, debe, haber, saldo }
  },

  // Cargo manual (suma deuda) o ajuste a favor (la baja)
  async agregarMovimiento(id, { tipo, monto, descripcion, fecha, id_usuario }) {
    const m = Math.round((Number(monto) || 0) * 100) / 100
    if (!(m > 0)) throw new Error('Ingresá un monto mayor a cero.')
    if (!['cargo', 'ajuste'].includes(tipo)) throw new Error('Elegí si es un cargo o un ajuste a favor.')
    const esCargo = tipo === 'cargo'
    const dia = /^\d{4}-\d{2}-\d{2}$/.test(String(fecha || '')) ? fecha : null
    const { rows } = await query(`
      INSERT INTO cc_proveedores (id_proveedor, tipo_movimiento, monto_debito, monto_credito, descripcion, fecha, id_usuario)
      VALUES (?, ?, ?, ?, ?, COALESCE(?, to_char(CURRENT_DATE, 'YYYY-MM-DD')), ?) RETURNING id
    `, [id, esCargo ? 'debito' : 'credito', esCargo ? m : 0, esCargo ? 0 : m, String(descripcion || '').trim().slice(0, 300), dia, id_usuario || null])
    return rows[0].id
  },

  async eliminarMovimiento(id, idMovimiento) {
    const r = await query(`DELETE FROM cc_proveedores WHERE id = ? AND id_proveedor = ? RETURNING id`, [idMovimiento, id])
    if (!r.rows.length) throw new Error('El movimiento no existe.')
  },
}

module.exports = EstacionesModel
