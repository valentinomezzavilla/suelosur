'use strict'
// Revisa que los saldos de los clientes cierren en todos los módulos (Cuenta corriente,
// Liquidaciones, Transacciones) y explica los saldos a favor.
//
//  · Saldo guardado distinto de la suma de sus movimientos.
//  · Ventas y alquileres a cuenta corriente / con saldo a favor cuyo cargo en la cuenta no es
//    lo que valen o lo que se cobró (o que tienen cargo sin corresponder): lo que corregiría
//    la puesta en regla del arranque (VentasModel / AlquileresModel.sincronizarCargoCC).
//  · Alquileres que no se corrigen solos (no se sabe qué vale): un método de pago en la
//    operación y otro en su cobro, o en la cuenta otro importe que lo cobrado. Se arreglan
//    editando el alquiler (precio / método) o en Transacciones (cambiar método).
//  · Clientes con saldo a favor: de qué pagos sale y qué tienen en curso / sin cobrar.
//
// Uso:
//   npm run revisar:saldos                     → muestra todo (no escribe nada)
//   npm run revisar:saldos -- --cliente=123    → el saldo de un cliente, en detalle
//   npm run revisar:saldos -- --corregir       → aplica las correcciones (lo mismo que hace
//                                                el sistema al arrancar)
//
// Usa la base del .env (producción): correr con --corregir solo con OK.

const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '..', '.env') })
const db = require('../src/config/db')
const { query, pool } = db
const VentasModel = require('../src/models/ventas.model')
const AlquileresModel = require('../src/models/alquileres.model')
const LiquidacionesModel = require('../src/models/liquidaciones.model')

const pesos = (n) => '$' + (Math.round((Number(n) || 0) * 100) / 100).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const nroOp = (n) => `OP-${String(n).padStart(4, '0')}`
const textoSaldo = (s) => s < -0.005 ? `debe ${pesos(-s)}` : (s > 0.005 ? `a favor ${pesos(s)}` : 'al día')

// Corre fn(q) en una transacción que se deshace: muestra lo que haría sin escribir nada.
// (En las pruebas el arnés ya tiene todo dentro de una transacción: corre directo.)
async function simular(fn) {
  if (process.env.SALDOS_SIN_SIMULAR === '1') return fn(query)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const q = (sql, params = []) => { let i = 0; return client.query(sql.replace(/\?/g, () => `$${++i}`), params) }
    return await fn(q)
  } finally {
    await client.query('ROLLBACK').catch(() => {})
    client.release()
  }
}

async function saldosDescuadrados(q = query) {
  return (await q(`
    SELECT c.id, c.numero, TRIM(COALESCE(c.nombre, '') || ' ' || COALESCE(c.apellido, '')) AS nombre, c.saldo,
           COALESCE((SELECT ROUND(SUM(m.monto)::numeric, 2) FROM movimientos_cuenta m WHERE m.cliente_id = c.id AND COALESCE(m.anulado, 0) = 0), 0)::float8 AS movimientos
    FROM clientes c
    WHERE ABS(COALESCE(c.saldo, 0) - COALESCE((SELECT SUM(m.monto) FROM movimientos_cuenta m WHERE m.cliente_id = c.id AND COALESCE(m.anulado, 0) = 0), 0)) > 0.004
    ORDER BY c.id
  `)).rows
}

// Lo que corregiría la puesta en regla de los cargos (sin escribir nada)
async function cargosACorregir() {
  return simular(async (q) => {
    const ventas = (await q(`
      SELECT DISTINCT op.id, op.nro_op FROM op_encabezado op
      WHERE op.tipo_op = 'M' AND (op.metodo_pago IN ('cuenta_corriente', 'saldo_a_favor')
         OR EXISTS (SELECT 1 FROM movimientos_cuenta m WHERE m.id_op_encabezado = op.id AND m.tipo IN ('deuda', 'uso_saldo_favor')))
      ORDER BY op.id`)).rows
    const alquileres = (await q(`
      SELECT op.id, op.nro_op FROM op_encabezado op
      WHERE op.tipo_op IN ('C', 'MA') AND (EXISTS (SELECT 1 FROM transacciones t WHERE t.id_op_encabezado = op.id)
         OR EXISTS (SELECT 1 FROM movimientos_cuenta m WHERE m.id_op_encabezado = op.id AND m.tipo IN ('deuda', 'uso_saldo_favor', 'ajuste')))
      ORDER BY op.id`)).rows
    const cambios = [], revisar = []
    for (const o of ventas) {
      const r = await VentasModel.sincronizarCargoCC(o.id, q)
      if (r) cambios.push(`${nroOp(o.nro_op)} (venta): ${r}`)
    }
    for (const o of alquileres) {
      const r = await AlquileresModel.sincronizarCargoCC(o.id, q, { conservador: true })
      if (r === 'revisar') revisar.push(nroOp(o.nro_op))
      else if (r) cambios.push(`${nroOp(o.nro_op)} (alquiler): ${r}`)
    }
    return { cambios, revisar: [...new Set(revisar)] }
  })
}

async function clientesConSaldoAFavor() {
  const clientes = (await query(`
    SELECT id, numero, TRIM(COALESCE(nombre, '') || ' ' || COALESCE(apellido, '')) AS nombre, saldo
    FROM clientes WHERE saldo > 0.005 ORDER BY saldo DESC`)).rows
  const res = []
  for (const c of clientes) res.push({ ...c, saldoCliente: await LiquidacionesModel.saldoCliente(c.id) })
  return res
}

function lineasSaldo(s) {
  const out = []
  const d = s.cuenta.desglose
  out.push(`  Cuenta corriente: ${textoSaldo(s.cuenta.saldo)}${s.cuenta.coincideConMovimientos ? '' : ` (¡sus movimientos suman ${textoSaldo(s.cuenta.saldoMovimientos)}!)`}`)
  if (s.cuenta.deuda > 0.005) out.push(`    Deuda: ${pesos(s.cuenta.deuda)} (del período ${pesos(d.periodo)}, anteriores ${pesos(d.anteriores)}, posteriores ${pesos(d.posteriores)}, cargos a mano ${pesos(d.manuales)})`)
  if (s.cuenta.aFavor > 0.005) {
    out.push(`    Pagos a favor sin aplicar: ${pesos(s.cuenta.aFavor)}, de:`)
    s.cuenta.creditos.forEach(cr => out.push(`      ${cr.fecha || '—'} · ${cr.descripcion || cr.tipo} · ${pesos(cr.sobrante)} de ${pesos(cr.monto)}`))
  }
  const bloque = (b, titulo) => {
    if (!b.ops.length) return
    out.push(`  ${titulo}: ${pesos(b.total)}`)
    b.ops.forEach(o => out.push(`      ${o.nro_remito ? 'Remito ' + o.nro_remito : nroOp(o.nro_op)} · ${o.fecha} · ${o.tipoTexto} · ${o.metodoTexto} · ${pesos(o.resta)}${o.estimado ? ' (estimado)' : ''}`))
  }
  bloque(s.sinCobrar, 'Sin cobrar fuera de la cuenta corriente')
  bloque(s.enCurso, 'Alquileres en curso (todavía sin cobrar ni cargar)')
  bloque(s.programadas, 'Sin entregar / sin iniciar')
  out.push(`  Total del cliente: ${s.total > 0.005 ? 'debe ' + pesos(s.total) : (s.total < -0.005 ? 'a favor ' + pesos(-s.total) : 'al día')}`)
  return out
}

async function main(args = process.argv.slice(2)) {
  const argCliente = args.find(a => a.startsWith('--cliente='))
  if (argCliente) {
    const id = argCliente.split('=')[1]
    const c = (await query(`SELECT id, numero, TRIM(COALESCE(nombre, '') || ' ' || COALESCE(apellido, '')) AS nombre FROM clientes WHERE id = ?`, [id])).rows[0]
    if (!c) { console.log('No existe el cliente', id); return }
    console.log(`\n=== #${c.numero} ${c.nombre} (id ${c.id}) ===`)
    lineasSaldo(await LiquidacionesModel.saldoCliente(c.id)).forEach(l => console.log(l))
    return
  }

  const desc = await saldosDescuadrados()
  console.log(`\n=== Saldo guardado distinto de la suma de sus movimientos (${desc.length}) — se corrige al arrancar ===`)
  desc.forEach(c => console.log(`  #${c.numero} ${c.nombre}: guardado ${textoSaldo(c.saldo)}, movimientos ${textoSaldo(c.movimientos)}`))

  const { cambios, revisar } = await cargosACorregir()
  console.log(`\n=== Cargos de la cuenta corriente que no coinciden con la operación (${cambios.length}) — se corrigen al arrancar ===`)
  cambios.forEach(l => console.log('  ' + l))
  console.log(`\n=== Alquileres para revisar a mano (${revisar.length}): método distinto en la operación y en el cobro, o en la cuenta otro importe que lo cobrado ===`)
  if (revisar.length) console.log('  ' + revisar.join(', ') + '\n  (editar el alquiler y guardar el método correcto, o cambiarlo en Transacciones)')

  const aFavor = await clientesConSaldoAFavor()
  console.log(`\n=== Clientes con saldo a favor (${aFavor.length}) ===`)
  for (const c of aFavor) {
    console.log(`\n#${c.numero} ${c.nombre}`)
    lineasSaldo(c.saldoCliente).forEach(l => console.log(l))
  }

  if (!args.includes('--corregir')) {
    if (desc.length || cambios.length) console.log('\nSimulación: no se escribió nada. Repetir con --corregir para aplicar (o reiniciar el sistema).')
    return
  }
  const corregidos = await db.instalarSaldoCalculado()
  const v = await VentasModel.sincronizarTodosLosCargosCC()
  const a = await AlquileresModel.sincronizarTodosLosCargosCC()
  console.log(`\nCorregido: ${corregidos.length} saldo(s), ${v.length} cargo(s) de ventas, ${a.cambios.length} de alquileres.`)
}

module.exports = { saldosDescuadrados, cargosACorregir, clientesConSaldoAFavor, lineasSaldo, main }

if (require.main === module) {
  main()
    .catch(e => { console.error('Error:', e.message); process.exitCode = 1 })
    .finally(() => pool.end())
}
