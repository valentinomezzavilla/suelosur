'use strict'
// Revisa qué operaciones figuran pagadas (o con pagos) por un motivo dudoso. SOLO LEE: no
// escribe nada. Para corregir una, abrir su cuenta corriente o Liquidaciones y usar
// "Marcar pendiente" / "Marcar como pagada".
//
//  1. Ventas a cuenta corriente / saldo a favor SIN cargo en la cuenta del cliente: Ventas y
//     Transacciones las muestran "saldadas" (sin deuda) y Liquidaciones "pendientes".
//  2. Operaciones en cuenta cubiertas por un pago hecho ANTES de la operación y aplicado solo
//     (a lo más viejo, sin que nadie lo eligiera): suele ser un pago de otra cosa.
//  3. Operaciones cubiertas por un AJUSTE a favor cargado a mano (sin operación): no es un
//     pago, pero la cuenta lo aplica a las deudas más viejas.
//  4. Operaciones de contado ya entregadas sin ningún cobro registrado (pendientes de verdad,
//     pero fuera de la cuenta corriente: no suman al saldo del cliente).
//
// Uso:
//   npm run revisar:pagos                    → todo
//   npm run revisar:pagos -- --cliente=123   → un cliente

const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '..', '.env') })
const { query, pool } = require('../src/config/db')
const ClientesModel = require('../src/models/clientes.model')
const { porOperacion } = require('../src/utils/imputacion')
const { fechaDeOperacion } = require('../src/utils/fechaOperacion')

const pesos = (n) => '$' + (Math.round((Number(n) || 0) * 100) / 100).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const nroOp = (n) => `OP-${String(n).padStart(4, '0')}`
const fechaCorta = (f) => String(f || '').slice(0, 10).split('-').reverse().join('/')
const METODO = { efectivo: 'efectivo', transferencia: 'transferencia', cheque: 'cheque', echeq: 'echeq' }

// 1) Ventas en cuenta sin cargo
async function ventasSinCargo(clienteId = null) {
  return (await query(`
    SELECT op.id, op.nro_op, op.id_cliente, op.estado, op.fecha_emision, op.metodo_pago,
           TRIM(COALESCE(c.nombre, '') || ' ' || COALESCE(c.apellido, '')) AS cliente
    FROM op_encabezado op LEFT JOIN clientes c ON c.id = op.id_cliente
    WHERE op.tipo_op = 'M' AND op.estado <> 'anulado' AND op.id_cliente IS NOT NULL
      AND op.metodo_pago IN ('cuenta_corriente', 'saldo_a_favor')
      AND NOT EXISTS (SELECT 1 FROM movimientos_cuenta m WHERE m.id_op_encabezado = op.id AND m.tipo IN ('deuda', 'uso_saldo_favor') AND COALESCE(m.anulado, 0) = 0)
      ${clienteId ? 'AND op.id_cliente = ?' : ''}
    ORDER BY op.id`, clienteId ? [clienteId] : [])).rows
}

// 2 y 3) Operaciones en cuenta cubiertas por un pago dudoso
async function cubiertasDudosas(clienteId = null) {
  const ids = clienteId ? [{ cliente_id: clienteId }] : (await query(
    `SELECT DISTINCT cliente_id FROM movimientos_cuenta WHERE COALESCE(anulado, 0) = 0 AND monto > 0`)).rows
  const hallazgos = []
  for (const { cliente_id } of ids) {
    const imp = await ClientesModel.imputacionDe(cliente_id)
    const movs = new Map(imp.movs.map(m => [String(m.id), m]))
    const pagado = porOperacion(imp.cargos)
    const idsOp = Object.keys(pagado)
    if (!idsOp.length) continue
    const ops = Object.fromEntries((await query(
      `SELECT id, nro_op, tipo_op, fecha_emision, fecha_entrega_planificada FROM op_encabezado WHERE id = ANY(?::bigint[])`,
      [idsOp.map(Number)])).rows.map(r => [String(r.id), r]))
    const cli = (await query(`SELECT TRIM(COALESCE(nombre, '') || ' ' || COALESCE(apellido, '')) AS n FROM clientes WHERE id = ?`, [cliente_id])).rows[0]
    const porOp = new Map()
    for (const [idPago, lista] of Object.entries(imp.aplicaciones)) {
      const pago = movs.get(String(idPago))
      if (!pago) continue
      for (const a of lista) {
        const op = a.idOp ? ops[String(a.idOp)] : null
        if (!op) continue
        const fechaOp = fechaDeOperacion(op)
        const fechaPago = String(pago.created_at || '').slice(0, 10)
        let motivo = null
        if (pago.tipo === 'ajuste') motivo = 'ajuste a favor cargado a mano'
        else if (!a.elegida && fechaOp && fechaPago && fechaPago < fechaOp) motivo = 'pago anterior a la operación, aplicado solo a lo más viejo'
        if (!motivo) continue
        const h = porOp.get(String(a.idOp)) || { cliente_id, cliente: cli ? cli.n : '', idOp: Number(a.idOp), nro_op: op.nro_op, fecha: fechaOp, total: pagado[a.idOp].total, pagado: pagado[a.idOp].pagado, pagos: [] }
        h.pagos.push({ motivo, id: Number(idPago), fecha: fechaPago, monto: Number(pago.monto), metodo: pago.metodo_pago, aplicado: a.monto, descripcion: pago.descripcion || '' })
        porOp.set(String(a.idOp), h)
      }
    }
    hallazgos.push(...porOp.values())
  }
  return hallazgos
}

// 4) De contado, entregadas, sin ningún cobro
async function contadoSinCobro(clienteId = null) {
  return (await query(`
    SELECT op.id, op.nro_op, op.id_cliente, op.tipo_op, op.fecha_emision, op.metodo_pago,
           TRIM(COALESCE(c.nombre, '') || ' ' || COALESCE(c.apellido, '')) AS cliente
    FROM op_encabezado op LEFT JOIN clientes c ON c.id = op.id_cliente
    WHERE op.tipo_op = 'M' AND op.estado = 'entregado' AND op.id_cliente IS NOT NULL
      AND COALESCE(op.metodo_pago, 'efectivo') IN ('efectivo', 'transferencia', 'cheque', 'echeq')
      AND NOT EXISTS (SELECT 1 FROM transacciones t WHERE t.id_op_encabezado = op.id AND t.tipo <> 'Ajuste')
      ${clienteId ? 'AND op.id_cliente = ?' : ''}
    ORDER BY op.id`, clienteId ? [clienteId] : [])).rows
}

async function main(args = process.argv.slice(2)) {
  const arg = args.find(a => a.startsWith('--cliente='))
  const clienteId = arg ? arg.split('=')[1] : null
  const sinCargo = await ventasSinCargo(clienteId)
  console.log(`\n=== 1. Ventas a cuenta corriente / saldo a favor SIN cargo en la cuenta (${sinCargo.length}) ===`)
  console.log('    Ventas y Transacciones las muestran saldadas; Liquidaciones, pendientes.')
  sinCargo.forEach(o => console.log(`  ${nroOp(o.nro_op)} · ${o.cliente} · ${fechaCorta(o.fecha_emision)} · ${o.estado}`))

  const dudosas = await cubiertasDudosas(clienteId)
  const porMotivo = (m) => dudosas.filter(h => h.pagos.some(p => p.motivo === m))
  for (const [n, motivo] of [[2, 'pago anterior a la operación, aplicado solo a lo más viejo'], [3, 'ajuste a favor cargado a mano']]) {
    const lista = porMotivo(motivo)
    console.log(`\n=== ${n}. Operaciones cubiertas por: ${motivo} (${lista.length}) ===`)
    lista.forEach(h => {
      console.log(`  ${nroOp(h.nro_op)} · ${h.cliente} · ${fechaCorta(h.fecha)} · pagado ${pesos(h.pagado)} de ${pesos(h.total)}`)
      h.pagos.filter(p => p.motivo === motivo).forEach(p =>
        console.log(`      ← movimiento ${p.id} del ${fechaCorta(p.fecha)} por ${pesos(p.monto)}${p.metodo ? ' (' + (METODO[p.metodo] || p.metodo) + ')' : ''}: aplicó ${pesos(p.aplicado)}${p.descripcion ? ' — ' + p.descripcion : ''}`))
    })
  }

  const sinCobro = await contadoSinCobro(clienteId)
  console.log(`\n=== 4. Ventas de contado entregadas SIN ningún cobro registrado (${sinCobro.length}) ===`)
  console.log('    Están pendientes de verdad pero fuera de la cuenta corriente: no suman al saldo.')
  sinCobro.forEach(o => console.log(`  ${nroOp(o.nro_op)} · ${o.cliente} · ${fechaCorta(o.fecha_emision)} · ${o.metodo_pago || 'efectivo'}`))

  console.log('\nPara cambiar el estado de una: Liquidaciones o Cuenta corriente → "Marcar pendiente" / "Marcar como pagada".')
  return { sinCargo, dudosas, sinCobro }
}

module.exports = { ventasSinCargo, cubiertasDudosas, contadoSinCobro, main }

if (require.main === module) {
  main()
    .catch(e => { console.error('Error:', e.message); process.exitCode = 1 })
    .finally(() => pool.end())
}
