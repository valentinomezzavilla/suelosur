'use strict'
// Corrige la fecha de los cargos de cuenta corriente que quedaron en el día del cobro en
// lugar del día de su operación (ej. un alquiler de septiembre cobrado en octubre figuraba
// en octubre). Solo mueve cargos hacia ATRÁS, nunca hacia el futuro; no toca pagos, saldos
// ni importes: únicamente la fecha (created_at) de los cargos y ajustes que tienen operación.
//
// Uso:
//   npm run corregir:fecha-cargos                    → simula: lista lo que cambiaría (no escribe nada)
//   npm run corregir:fecha-cargos -- --cliente=122   → simula solo para un cliente
//   npm run corregir:fecha-cargos -- --aplicar       → aplica (guarda antes la fecha anterior en bkp_fecha_cargos)
//   npm run corregir:fecha-cargos -- --revertir      → devuelve las fechas que guardó el respaldo
//
// Escribe en la base del entorno (producción): correr con --aplicar solo con OK.

const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '..', '.env') })
const { query, transaction, pool } = require('../src/config/db')
const { hoyISO } = require('../src/utils/fecha')

// Fecha de la operación: la misma regla que ClientesModel.fechaCargoDeOperacion
const SQL_FECHA_OP = `CASE WHEN op.tipo_op = 'M' THEN LEFT(op.fecha_emision, 10)
  ELSE LEFT(COALESCE(NULLIF(op.fecha_entrega_planificada, ''), op.fecha_emision), 10) END`

async function candidatos({ clienteId } = {}) {
  const params = [hoyISO()]
  let filtroCliente = ''
  if (clienteId) { params.push(clienteId); filtroCliente = `AND m.cliente_id = $${params.length}` }
  return (await query(`
    SELECT * FROM (
      SELECT m.id, m.cliente_id, m.tipo, m.monto, m.created_at AS anterior, op.tipo_op, op.nro_op,
             (${SQL_FECHA_OP}) AS fecha_op,
             TRIM(COALESCE(c.nombre, '') || ' ' || COALESCE(c.apellido, '')) AS cliente
      FROM movimientos_cuenta m
      JOIN op_encabezado op ON op.id = m.id_op_encabezado
      LEFT JOIN clientes c ON c.id = m.cliente_id
      WHERE m.tipo IN ('deuda', 'uso_saldo_favor', 'ajuste') ${filtroCliente}
    ) x
    WHERE fecha_op < $1 AND LEFT(anterior, 10) > fecha_op
    ORDER BY cliente_id, fecha_op, id
  `, params)).rows
}

async function aplicar(filas) {
  return transaction(async (q) => {
    await q(`CREATE TABLE IF NOT EXISTS bkp_fecha_cargos (
      id_movimiento BIGINT PRIMARY KEY, created_at_anterior TEXT NOT NULL, respaldado_en TEXT DEFAULT ahora_local())`)
    for (const f of filas) {
      await q(`INSERT INTO bkp_fecha_cargos (id_movimiento, created_at_anterior) VALUES (?, ?) ON CONFLICT (id_movimiento) DO NOTHING`,
        [f.id, f.anterior])
      await q(`UPDATE movimientos_cuenta SET created_at = ? WHERE id = ?`, [`${f.fecha_op} 12:00:00`, f.id])
    }
    return filas.length
  })
}

async function revertir() {
  return transaction(async (q) => {
    const hay = (await q(`SELECT to_regclass('bkp_fecha_cargos') AS t`)).rows[0].t
    if (!hay) return 0
    const r = await q(`UPDATE movimientos_cuenta m SET created_at = b.created_at_anterior
      FROM bkp_fecha_cargos b WHERE b.id_movimiento = m.id`)
    await q(`DELETE FROM bkp_fecha_cargos`)
    return r.rowCount
  })
}

const plata = (n) => '$' + Math.abs(Number(n)).toLocaleString('es-AR', { maximumFractionDigits: 2 })
const mes = (iso) => String(iso).slice(0, 7)

function resumen(filas) {
  const lineas = []
  const porMes = new Map()
  for (const f of filas) {
    const k = `${mes(f.anterior)} → ${mes(f.fecha_op)}`
    const a = porMes.get(k) || { n: 0, monto: 0 }
    a.n++; a.monto += Number(f.monto)
    porMes.set(k, a)
  }
  lineas.push('Por mes (de dónde → adónde pasan):')
  for (const [k, a] of porMes) lineas.push(`  ${k}: ${a.n} cargo(s), ${plata(a.monto)}`)
  const porTipo = filas.reduce((o, f) => ((o[f.tipo_op] = (o[f.tipo_op] || 0) + 1), o), {})
  lineas.push('Por tipo de operación: ' + Object.entries(porTipo).map(([t, n]) => `${t}=${n}`).join(', '))
  return lineas.join('\n')
}

async function main() {
  const args = process.argv.slice(2)
  if (args.includes('--revertir')) {
    console.log(`Revertidas ${await revertir()} fecha(s) desde bkp_fecha_cargos.`)
    return
  }
  const clienteId = (args.find(a => a.startsWith('--cliente=')) || '').split('=')[1] || null
  const filas = await candidatos({ clienteId })
  if (!filas.length) { console.log('No hay cargos con fecha de cobro posterior a la de su operación.'); return }
  for (const f of filas) {
    console.log(`  ${(f.cliente || 'Particular').padEnd(28)} OP-${String(f.nro_op).padStart(4, '0')} (${f.tipo_op}) `
      + `${f.tipo.padEnd(15)} ${plata(f.monto).padStart(14)}  ${String(f.anterior).slice(0, 10)} → ${f.fecha_op}`)
  }
  console.log('\n' + resumen(filas))
  if (!args.includes('--aplicar')) {
    console.log(`\nSimulación: se corregirían ${filas.length} cargo(s). Repetir con --aplicar para escribirlo.`)
    return
  }
  console.log(`\nCorregidos ${await aplicar(filas)} cargo(s). Respaldo en bkp_fecha_cargos (revertir con --revertir).`)
}

module.exports = { candidatos, aplicar, revertir }

if (require.main === module) {
  main()
    .catch(e => { console.error('No se corrigió nada:', e.message); process.exitCode = 1 })
    .finally(() => pool.end())
}
