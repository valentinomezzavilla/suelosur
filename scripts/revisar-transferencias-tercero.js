'use strict'
// Revisa las transferencias "destinadas a tercero" repetidas (egresos con origen 'tercero').
//
//  · Repetidas por el mismo origen: dos o más egresos a tercero de la MISMA transacción o
//    del MISMO pago de cuenta corriente. Son duplicados seguros (un cobro genera uno solo):
//    con --aplicar se borran y queda el más viejo (respaldo en bkp_egresos_tercero).
//  · Parecidas: mismo monto, categoría, destinatario y día pero de cobros distintos. Puede
//    ser un cobro cargado dos veces (doble click) o dos cobros reales: NO se tocan. Si el
//    cobro del cliente está repetido, se anula ese pago / transacción desde la app, y eso
//    borra también su egreso a tercero.
//
// Uso:
//   npm run revisar:tercero                         → muestra todo (no escribe nada)
//   npm run revisar:tercero -- --buscar=desagotes    → además lista los egresos a tercero que coinciden
//   npm run revisar:tercero -- --aplicar             → borra los repetidos por el mismo origen
//
// Escribe en la base del entorno (producción): correr con --aplicar solo con OK.

const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '..', '.env') })
const { query, transaction, pool } = require('../src/config/db')

const SQL_EGRESO = `
  SELECT e.id, e.fecha, e.created_at, e.categoria, e.monto, e.descripcion, e.id_proveedor, p.nombre AS destinatario,
         e.id_transaccion, e.id_movimiento_cuenta, e.id_op_encabezado, e.id_pago_empleado,
         t.cliente AS cliente_tx, t.created_at AS tx_creada,
         TRIM(COALESCE(c.nombre, '') || ' ' || COALESCE(c.apellido, '')) AS cliente_mov, m.created_at AS mov_creado, m.anulado AS mov_anulado
  FROM egresos e
  LEFT JOIN proveedores p ON p.id = e.id_proveedor
  LEFT JOIN transacciones t ON t.id = e.id_transaccion
  LEFT JOIN movimientos_cuenta m ON m.id = e.id_movimiento_cuenta
  LEFT JOIN clientes c ON c.id = m.cliente_id
  WHERE e.origen = 'tercero'`

// Egresos a tercero que repiten la transacción o el pago de cuenta corriente de otro más viejo
async function repetidosMismoOrigen(q = query) {
  return (await q(`${SQL_EGRESO} AND EXISTS (
      SELECT 1 FROM egresos o WHERE o.origen = 'tercero' AND o.id < e.id AND (
        (e.id_transaccion IS NOT NULL AND o.id_transaccion = e.id_transaccion) OR
        (e.id_movimiento_cuenta IS NOT NULL AND o.id_movimiento_cuenta = e.id_movimiento_cuenta)))
    ORDER BY e.id`)).rows
}

async function parecidos() {
  return (await query(`${SQL_EGRESO} AND EXISTS (
      SELECT 1 FROM egresos o WHERE o.origen = 'tercero' AND o.id <> e.id AND o.monto = e.monto AND o.categoria = e.categoria
        AND COALESCE(o.id_proveedor, 0) = COALESCE(e.id_proveedor, 0) AND o.fecha = e.fecha
        AND NOT ((e.id_transaccion IS NOT NULL AND o.id_transaccion = e.id_transaccion)
              OR (e.id_movimiento_cuenta IS NOT NULL AND o.id_movimiento_cuenta = e.id_movimiento_cuenta)))
    ORDER BY e.fecha, e.monto, e.id`)).rows
}

async function buscar(texto) {
  const t = `%${texto}%`
  return (await query(`${SQL_EGRESO} AND (e.descripcion ILIKE ? OR p.nombre ILIKE ? OR t.cliente ILIKE ?
      OR TRIM(COALESCE(c.nombre, '') || ' ' || COALESCE(c.apellido, '')) ILIKE ?)
    ORDER BY e.id`, [t, t, t, t])).rows
}

// Borra los repetidos por el mismo origen (y el pago de sueldo que tengan atado), con respaldo
async function aplicar() {
  return transaction(async (q) => {
    const filas = await repetidosMismoOrigen(q)
    if (!filas.length) return 0
    await q(`CREATE TABLE IF NOT EXISTS bkp_egresos_tercero (
      tabla TEXT NOT NULL, fila_id BIGINT NOT NULL, datos TEXT NOT NULL, respaldado_en TEXT DEFAULT ahora_local())`)
    for (const f of filas) {
      await q(`INSERT INTO bkp_egresos_tercero (tabla, fila_id, datos) SELECT 'egresos', id, row_to_json(e)::text FROM egresos e WHERE id = ?`, [f.id])
      if (f.id_pago_empleado) {
        await q(`INSERT INTO bkp_egresos_tercero (tabla, fila_id, datos) SELECT 'pagos_empleado', id, row_to_json(p)::text FROM pagos_empleado p WHERE id = ?`, [f.id_pago_empleado])
        await q(`DELETE FROM pagos_empleado WHERE id = ?`, [f.id_pago_empleado])
      }
      await q(`DELETE FROM egresos WHERE id = ?`, [f.id])
    }
    return filas.length
  })
}

const plata = (n) => '$' + Number(n || 0).toLocaleString('es-AR', { maximumFractionDigits: 2 })
function linea(e) {
  const origen = e.id_transaccion ? `transacción #${e.id_transaccion} de ${e.cliente_tx || '?'} (cargada ${String(e.tx_creada || '').slice(0, 16)})`
    : e.id_movimiento_cuenta ? `pago de cta. cte. #${e.id_movimiento_cuenta} de ${e.cliente_mov || '?'} (cargado ${String(e.mov_creado || '').slice(0, 16)}${Number(e.mov_anulado) ? ', ANULADO' : ''})`
    : 'sin cobro asociado'
  return `  egreso #${e.id}  ${String(e.fecha).slice(0, 10)}  ${plata(e.monto).padStart(14)}  ${e.categoria} → ${e.destinatario || '—'}\n`
    + `      ${e.descripcion || ''}\n      origen: ${origen}`
}

async function main() {
  const args = process.argv.slice(2)
  const texto = (args.find(a => a.startsWith('--buscar=')) || '').split('=').slice(1).join('=').trim()

  if (texto) {
    const filas = await buscar(texto)
    console.log(`\n=== Egresos a tercero que coinciden con "${texto}" (${filas.length}) ===`)
    filas.forEach(e => console.log(linea(e)))
  }

  const parec = await parecidos()
  console.log(`\n=== Parecidos: mismo monto, destino y día, de cobros distintos (${parec.length}) — no se tocan ===`)
  parec.forEach(e => console.log(linea(e)))

  const rep = await repetidosMismoOrigen()
  console.log(`\n=== Repetidos del mismo cobro (${rep.length}) — se borran con --aplicar ===`)
  rep.forEach(e => console.log(linea(e)))

  if (!rep.length) { console.log('\nNo hay egresos a tercero repetidos del mismo cobro.'); return }
  if (!args.includes('--aplicar')) {
    console.log(`\nSimulación: se borrarían ${rep.length} egreso(s) repetido(s). Repetir con --aplicar para hacerlo.`)
    return
  }
  console.log(`\nBorrados ${await aplicar()} egreso(s) repetido(s). Respaldo en bkp_egresos_tercero.`)
}

module.exports = { repetidosMismoOrigen, parecidos, buscar, aplicar, main }

if (require.main === module) {
  main()
    .catch(e => { console.error('No se modificó nada:', e.message); process.exitCode = 1 })
    .finally(() => pool.end())
}
