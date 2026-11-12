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
//  5. Pagos REPETIDOS: mismo cliente, importe, método y descripción cargados con pocos minutos de
//     diferencia (un doble envío, o repetir "Saldar" porque la operación seguía pendiente).
//  4. Operaciones de contado ya entregadas sin ningún cobro registrado (pendientes de verdad,
//     pero fuera de la cuenta corriente: no suman al saldo del cliente).
//
// Uso:
//   npm run revisar:pagos                    → todo
//   npm run revisar:pagos -- --buscar=co.c   → busca clientes por nombre o N° y muestra su detalle (hasta 3)
//   npm run revisar:pagos -- --cliente=123   → un cliente (id interno), con el detalle de su cuenta: cada pago y
//                                              a qué operaciones se aplicó, y cada operación

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

// 5) Pagos repetidos: mismo cliente, importe, método y descripción, cargados con pocos minutos de
// diferencia (un doble envío, o repetir "Saldar" porque la operación seguía figurando pendiente).
// Un pago igual cargado otro día no cuenta: puede ser una cuota. Devuelve grupos de 2 o más.
const MINUTOS_REPETIDO = 30
async function pagosRepetidos(clienteId = null) {
  const filas = (await query(`
    SELECT m.id, m.cliente_id, m.monto, m.metodo_pago, COALESCE(m.descripcion, '') AS descripcion, m.created_at, m.registrado_en,
           TRIM(COALESCE(c.nombre, '') || ' ' || COALESCE(c.apellido, '')) AS cliente
    FROM movimientos_cuenta m JOIN clientes c ON c.id = m.cliente_id
    WHERE m.tipo = 'pago' AND COALESCE(m.anulado, 0) = 0 AND m.registrado_en IS NOT NULL
      ${clienteId ? 'AND m.cliente_id = ?' : ''}
    ORDER BY m.cliente_id, m.monto, m.metodo_pago, m.descripcion, m.registrado_en, m.id`, clienteId ? [clienteId] : [])).rows
  const instante = (t) => new Date(String(t).replace(' ', 'T')).getTime()
  const misma = (a, b) => a.cliente_id === b.cliente_id && Number(a.monto) === Number(b.monto)
    && (a.metodo_pago || '') === (b.metodo_pago || '') && a.descripcion === b.descripcion
  const grupos = []
  let actual = []
  for (const fila of filas) {
    const ultima = actual[actual.length - 1]
    if (ultima && misma(ultima, fila) && Math.abs(instante(fila.registrado_en) - instante(ultima.registrado_en)) <= MINUTOS_REPETIDO * 60000) actual.push(fila)
    else { if (actual.length > 1) grupos.push(actual); actual = [fila] }
  }
  if (actual.length > 1) grupos.push(actual)
  return grupos.map(g => ({
    cliente_id: g[0].cliente_id, cliente: g[0].cliente, monto: Number(g[0].monto), metodo: g[0].metodo_pago, descripcion: g[0].descripcion,
    pagos: g.map(p => ({ id: Number(p.id), fecha: String(p.created_at || '').slice(0, 10), cargado: String(p.registrado_en) })),
  }))
}

// Detalle de la cuenta de UN cliente: cada pago vigente y a qué operaciones se aplicó (elegidas al
// registrarlo o aplicado solo a lo más viejo), lo que quedó a favor, y cada operación con lo que
// debe y lo que se le aplicó. Sirve para ver por qué una operación sigue pendiente aunque se
// hayan hecho pagos "para ella", o por qué figura pagada.
async function detalleCliente(clienteId) {
  const cli = (await query(`SELECT id, numero, saldo, TRIM(COALESCE(nombre, '') || ' ' || COALESCE(apellido, '')) AS nombre FROM clientes WHERE id = ?`, [clienteId])).rows[0]
  if (!cli) return null
  const imp = await ClientesModel.imputacionDe(cli.id)
  const aplicadoA = await ClientesModel.aplicacionesPorPago(imp)
  const idsOp = [...new Set(Object.values(imp.cargos).map(c => c.idOp).filter(Boolean).map(Number))]
  const ops = idsOp.length ? Object.fromEntries((await query(
    `SELECT id, nro_op, tipo_op, fecha_emision, fecha_entrega_planificada FROM op_encabezado WHERE id = ANY(?::bigint[])`, [idsOp])).rows.map(r => [String(r.id), r])) : {}
  const sobrante = Object.fromEntries(imp.creditos.map(c => [String(c.id), c.sobrante]))
  const cargado = Object.fromEntries((await query(`SELECT id, registrado_en FROM movimientos_cuenta WHERE cliente_id = ?`, [cli.id])).rows.map(r => [String(r.id), r.registrado_en]))
  const pagos = imp.movs.filter(m => Number(m.monto) > 0).map(m => ({
    id: m.id, fecha: String(m.created_at || '').slice(0, 10), tipo: m.tipo, metodo: m.metodo_pago, monto: Number(m.monto),
    descripcion: m.descripcion || '', aplicado: aplicadoA[m.id] || [], aFavor: sobrante[String(m.id)] || 0, cargado: cargado[String(m.id)] || null,
  }))
  const porOp = porOperacion(imp.cargos)
  const operaciones = idsOp.map(id => ({
    idOp: id, nro_op: ops[String(id)] ? ops[String(id)].nro_op : null, fecha: ops[String(id)] ? fechaDeOperacion(ops[String(id)]) : null,
    total: porOp[id] ? porOp[id].total : 0, pagado: porOp[id] ? porOp[id].pagado : 0,
  })).sort((a, b) => String(a.fecha).localeCompare(String(b.fecha)) || a.idOp - b.idOp)
  return { cliente: cli, pagos, operaciones, aFavor: imp.aFavor }
}

function imprimirDetalle(d) {
  console.log(`\n=== Cuenta de #${d.cliente.numero} ${d.cliente.nombre} — saldo guardado ${pesos(d.cliente.saldo)} ===`)
  console.log(`\nPagos vigentes (${d.pagos.length}) y a qué se aplicó cada uno:`)
  d.pagos.forEach(p => {
    console.log(`  mov ${p.id} (PAG-${String(p.id).padStart(6, '0')}) · pago del ${fechaCorta(p.fecha)}${p.cargado ? ', cargado el ' + fechaCorta(p.cargado) + ' a las ' + String(p.cargado).slice(11, 19) : ''} · ${pesos(p.monto)}${p.metodo ? ' (' + (METODO[p.metodo] || p.metodo) + ')' : ''} · ${p.tipo}${p.descripcion ? ' · ' + p.descripcion : ''}`)
    if (!p.aplicado.length && !(p.aFavor > 0.005)) console.log('      (no se aplicó a nada)')
    p.aplicado.forEach(a => console.log(`      → ${a.etiqueta} ${pesos(a.monto)} ${a.elegida ? '(elegido al registrar el pago)' : '(aplicado solo, a lo más viejo)'}`))
    if (p.aFavor > 0.005) console.log(`      → quedó a favor ${pesos(p.aFavor)}`)
  })
  console.log(`\nOperaciones en la cuenta (de la más vieja a la más nueva):`)
  d.operaciones.forEach(o => console.log(`  ${o.nro_op != null ? nroOp(o.nro_op) : 'op ' + o.idOp} · ${fechaCorta(o.fecha)} · total ${pesos(o.total)} · pagado ${pesos(o.pagado)} · resta ${pesos(o.total - o.pagado)}`))
  if (d.aFavor > 0.005) console.log(`\nSaldo a favor sin aplicar: ${pesos(d.aFavor)}`)
}

// Clientes por nombre (o apellido) o por N° de cliente
async function buscarClientes(texto) {
  const t = String(texto || '').trim()
  if (!t) return []
  return (await query(`
    SELECT id, numero, TRIM(COALESCE(nombre, '') || ' ' || COALESCE(apellido, '')) AS nombre, saldo
    FROM clientes
    WHERE TRIM(COALESCE(nombre, '') || ' ' || COALESCE(apellido, '')) ILIKE ? OR CAST(numero AS TEXT) = ?
    ORDER BY id LIMIT 20`, ['%' + t + '%', t])).rows
}

function imprimirRepetidos(repetidos) {
  console.log(`\n=== 5. Pagos REPETIDOS: mismo cliente, importe, método y descripción, cargados con menos de ${MINUTOS_REPETIDO} minutos de diferencia (${repetidos.length}) ===`)
  console.log('    Si la plata no entró varias veces, anular los de más desde la Cuenta corriente (Anular).')
  repetidos.forEach(g => {
    console.log(`  ${g.cliente} · ${g.pagos.length} pagos de ${pesos(g.monto)}${g.metodo ? ' (' + (METODO[g.metodo] || g.metodo) + ')' : ''}${g.descripcion ? ' — ' + g.descripcion : ''}`)
    g.pagos.forEach(p => console.log(`      PAG-${String(p.id).padStart(6, '0')} · pago del ${fechaCorta(p.fecha)} · cargado el ${fechaCorta(p.cargado)} a las ${p.cargado.slice(11, 19)}`))
  })
}

async function main(args = process.argv.slice(2)) {
  const buscar = args.find(a => a.startsWith('--buscar='))
  if (buscar) {
    const encontrados = await buscarClientes(buscar.slice('--buscar='.length))
    console.log(`\n=== Clientes que coinciden (${encontrados.length}) ===`)
    encontrados.forEach(c => console.log(`  id ${c.id} · N° ${c.numero} · ${c.nombre} · saldo ${pesos(c.saldo)}`))
    if (!encontrados.length) console.log('  (ninguno)')
    else if (encontrados.length > 3) console.log('\nSon muchos: repetí con --cliente=ID (el id de la lista) para ver el detalle de uno.')
    else {
      for (const c of encontrados) {
        imprimirDetalle(await detalleCliente(c.id))
        imprimirRepetidos(await pagosRepetidos(c.id))
      }
    }
    return { encontrados }
  }
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

  const repetidos = await pagosRepetidos(clienteId)
  imprimirRepetidos(repetidos)
  if (clienteId) {
    const detalle = await detalleCliente(clienteId)
    if (detalle) imprimirDetalle(detalle)
    else console.log(`\nNo existe el cliente con id ${clienteId}. --cliente toma el id interno (el de la URL /clientes/cuentas/ID), no el N° de cliente: para buscar por nombre o N° usá --buscar=texto`)
  }
  console.log('\nPara cambiar el estado de una: Liquidaciones o Cuenta corriente → "Marcar pendiente" / "Marcar como pagada".')
  return { sinCargo, dudosas, sinCobro, repetidos }
}

module.exports = { ventasSinCargo, cubiertasDudosas, contadoSinCobro, pagosRepetidos, detalleCliente, buscarClientes, main }

if (require.main === module) {
  main()
    .catch(e => { console.error('Error:', e.message); process.exitCode = 1 })
    .finally(() => pool.end())
}
