'use strict'
// ═══════════════════════════════════════════════════════════════════
// estadoPago.model.js — "Marcar pendiente" / "Marcar pagada" una operación.
//
// El estado de pago de una operación NO es un campo: se deduce de los registros de pago
// (la cuenta corriente con su imputación, o las transacciones de contado). Por eso cambiarlo
// es cambiar esos registros, y el saldo del cliente (que lo recalcula la base) acompaña solo:
//
//  · Marcar PENDIENTE una operación en cuenta corriente: se quita de los pagos lo que se le
//    había aplicado. Cada pago afectado se anula (queda en el historial con el motivo) y, si le
//    sobraba plata para otras operaciones, se registra de nuevo por esa parte, con las
//    operaciones a las que iba escritas, así nada más cambia. Si lo que sobra volvería a
//    cubrir la operación (un saldo a favor), también se quita: una operación con deuda y plata
//    a favor se compensan solas, y solo sin ese crédito queda pendiente.
//  · Marcar PENDIENTE una venta cobrada de contado: el cobro pasa a cuenta corriente (el
//    cliente pasa a deber lo que figuraba cobrado), igual que cambiar el método en Transacciones.
//  · Marcar PAGADA una venta de contado sin cobro: se registra el cobro por lo que falta. (En
//    cuenta corriente se usa "Saldar", que registra el pago eligiendo método y fecha.)
//
// Todo se hace en una transacción y se VERIFICA antes de confirmar: la operación quedó como se
// pidió, ninguna otra operación del cliente cambió de estado y el saldo se movió exactamente
// lo esperado. Si algo no cierra, no se guarda nada.
// ═══════════════════════════════════════════════════════════════════
const { query, transaction } = require('../config/db')
const ClientesModel = require('./clientes.model')
const { imputar, porOperacion } = require('../utils/imputacion')
const L = require('../utils/liquidaciones')

const EPS = 0.005
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100
const EN_CUENTA = ['cuenta_corriente', 'saldo_a_favor']
const SIN_COBRO = [...EN_CUENTA, 'a_convenir']
const COBRO_CONTADO = ['efectivo', 'transferencia']
const nroOp = (n) => `OP-${String(n).padStart(4, '0')}`
const pesos = (n) => '$' + r2(n).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const fechaCorta = (f) => String(f || '').slice(0, 10).split('-').reverse().join('/')
const METODO_TXT = { efectivo: 'efectivo', transferencia: 'transferencia', cheque: 'cheque', echeq: 'echeq' }

// ── Lógica pura: qué hay que quitarle a cada pago ───────────────────

// Lo que un pago aplicó, sin la operación `X`, agrupado por destino:
// Map('o:ID' | 'c:ID' → { idOp, idCargo, monto })
function aplicadoSinX(imp, idPago, X) {
  const m = new Map()
  for (const a of imp.aplicaciones[idPago] || []) {
    if (a.idOp && X.has(String(a.idOp))) continue
    const clave = a.idOp ? `o:${a.idOp}` : `c:${a.idCargo}`
    const prev = m.get(clave)
    if (prev) prev.monto = r2(prev.monto + a.monto)
    else m.set(clave, { idOp: a.idOp || null, idCargo: a.idOp ? null : a.idCargo, monto: r2(a.monto) })
  }
  return m
}
const aplicadoAX = (imp, idPago, X) =>
  r2((imp.aplicaciones[idPago] || []).filter(a => a.idOp && X.has(String(a.idOp))).reduce((s, a) => s + a.monto, 0))
const mismoAplicado = (a, b) => {
  if (a.size !== b.size) return false
  for (const [k, v] of a) { const w = b.get(k); if (!w || Math.abs(w.monto - v.monto) > EPS) return false }
  return true
}
const pagadoDe = (imp, X) => { const po = porOperacion(imp.cargos); let t = 0; for (const id of X) t += po[id] ? po[id].pagado : 0; return t }

// Qué hay que cambiar de los pagos para que la operación `idOp` (o varias: un array, las de un
// remito) quede pendiente sin tocar el resto. movs: movimientos vigentes del cliente (en el orden de la cuenta); asignaciones: las
// operaciones elegidas de cada pago.
// → { pagadoAntes, cambios: [{ idPago, montoOriginal, montoNuevo, imputaciones, tocaMonto }], sinCambios }
// Tira un Error si no se puede dejar pendiente sin alterar otras operaciones.
function calcularReversion(movs, asignaciones, idOps) {
  const X = new Set([].concat(idOps).map(String))
  const base = imputar(movs, asignaciones)
  const pagadoAntes = pagadoDe(base, X)
  if (pagadoAntes <= EPS) return { pagadoAntes: 0, cambios: [] }

  // Un ajuste a favor de una operación (rebaja de precio) no es plata que entró: no se toca
  const positivos = movs.filter(m => Number(m.monto) > 0 && !(m.tipo === 'ajuste' && m.id_op_encabezado))
  const estado = new Map()   // idPago → { monto, imputaciones: Map }

  const armar = () => ({
    movs: movs.map(m => estado.has(String(m.id)) ? { ...m, monto: estado.get(String(m.id)).monto } : m),
    asig: asignaciones.filter(a => !estado.has(String(a.id_pago))).concat(
      [...estado].flatMap(([idPago, st]) => [...st.imputaciones.values()].map(e => ({
        id_pago: idPago, id_op_encabezado: e.idOp, id_cargo: e.idCargo, monto: e.monto,
      })))),
  })

  // Primero: quitar de cada pago lo que se le aplicó a la operación, dejando escrito a qué
  // otras operaciones iba (para que no cambie de destino al desaparecer ésta)
  for (const p of positivos) {
    const ax = aplicadoAX(base, p.id, X)
    if (ax > EPS) estado.set(String(p.id), { monto: r2(p.monto - ax), imputaciones: aplicadoSinX(base, p.id, X) })
  }
  // Después: si algo sobrante volviera a cubrir la operación, o un pago cambiara de destino, se corrige
  let estable = false
  for (let i = 0; i < 60 && !estable; i++) {
    const { movs: m2, asig } = armar()
    const imp = imputar(m2, asig)
    estable = true
    for (const p of positivos) {
      const id = String(p.id)
      const ax = aplicadoAX(imp, id, X)
      const st = estado.get(id)
      if (st) {
        if (ax > EPS) { st.monto = r2(Math.max(0, st.monto - ax)); estable = false }
      } else if (ax > EPS || !mismoAplicado(aplicadoSinX(imp, id, X), aplicadoSinX(base, id, X))) {
        estado.set(id, { monto: Number(p.monto), imputaciones: aplicadoSinX(base, id, X) })
        estable = false
      }
    }
  }
  if (!estable) throw new Error('No se pudo calcular el cambio de forma segura. No se modificó nada.')

  const { movs: m2, asig } = armar()
  const final = imputar(m2, asig)
  if (pagadoDe(final, X) > EPS) throw new Error('La operación seguiría con pagos aplicados. No se modificó nada.')
  const distinto = diferenciasConBase(base, final, X)
  if (distinto) throw new Error(`Dejar pendiente esta operación cambiaría también ${distinto}. No se modificó nada.`)

  const cambios = []
  for (const p of positivos) {
    const st = estado.get(String(p.id))
    if (!st) continue
    const montoNuevo = r2(Math.max(0, st.monto))
    const tocaMonto = Math.abs(montoNuevo - Number(p.monto)) > EPS
    const imputaciones = montoNuevo > EPS ? [...st.imputaciones.values()].filter(e => e.monto > EPS) : []
    cambios.push({ idPago: p.id, montoOriginal: r2(p.monto), montoNuevo, imputaciones, tocaMonto })
  }
  return { pagadoAntes, cambios }
}

// ¿Otra operación (o cargo a mano) quedó con otro pagado que antes? Texto de lo que cambió, o null.
function diferenciasConBase(a, b, X) {
  const pa = porOperacion(a.cargos), pb = porOperacion(b.cargos)
  for (const id of new Set([...Object.keys(pa), ...Object.keys(pb)])) {
    if (X.has(id)) continue
    if (Math.abs((pa[id] ? pa[id].pagado : 0) - (pb[id] ? pb[id].pagado : 0)) > 0.01) return 'otra operación del cliente'
  }
  for (const [id, c] of Object.entries(a.cargos)) {
    if (c.idOp) continue
    if (!b.cargos[id] || Math.abs(c.restante - b.cargos[id].restante) > 0.01) return 'un cargo a mano del cliente'
  }
  return null
}

// ── Lectura de la operación ───────────────────────────────────────────

async function cargarOp(idOp, q = query) {
  return (await q(`
    SELECT op.id, op.nro_op, op.nro_remito, op.tipo_op, op.modalidad, op.id_cliente, op.id_grupo, op.estado,
           COALESCE(op.metodo_pago, oc.metodo_pago, om.metodo_pago) AS metodo_pago, (ag.cobro_modo = 'alquiler') AS grupo_todo_junto
    FROM op_encabezado op
    LEFT JOIN LATERAL (SELECT metodo_pago FROM op_detalle_contenedor d WHERE d.id_orden_pedido = op.id ORDER BY d.id LIMIT 1) oc ON TRUE
    LEFT JOIN LATERAL (SELECT metodo_pago FROM op_detalle_maquinaria d WHERE d.id_orden_pedido = op.id ORDER BY d.id LIMIT 1) om ON TRUE
    LEFT JOIN alquiler_grupos ag ON ag.id = op.id_grupo
    WHERE op.id = ?`, [idOp])).rows[0] || null
}

// Cobros de contado de la operación (la plata que entró), de los más viejos a los más nuevos
async function cobrosDeContado(idOp, q = query) {
  return (await q(`SELECT id, monto, metodo_pago, fecha, tipo FROM transacciones
                   WHERE id_op_encabezado = ? AND tipo <> 'Ajuste' AND NOT (COALESCE(metodo_pago, 'efectivo') = ANY(?)) ORDER BY id`,
    [idOp, SIN_COBRO])).rows
}

const saldoDe = async (idCliente, q = query) => r2(((await q(`SELECT saldo FROM clientes WHERE id = ?`, [idCliente])).rows[0] || {}).saldo)

// ── Marcar PENDIENTE ──────────────────────────────────────────────────
// Un remito puede tener varias operaciones (mismo cliente y mismo N° de remito). "Marcar
// pendiente" las deja pendientes a TODAS juntas y no toca a ninguna otra del cliente: el cálculo
// se hace de una vez para todo el conjunto y, antes de guardar, se verifica que las demás
// operaciones sigan con el mismo estado y el mismo saldo. Con `soloEsta` se deja pendiente
// únicamente la operación elegida.

// Las operaciones que comparten el remito de `op` (mismo cliente, sin anuladas); `op` va siempre.
async function opsDelRemito(op, q) {
  if (!op.nro_remito) return [op]
  const ids = (await q(`SELECT id FROM op_encabezado WHERE id_cliente = ? AND nro_remito = ? AND estado <> 'anulado' ORDER BY id`,
    [op.id_cliente, op.nro_remito])).rows.map(r => r.id)
  const ops = []
  for (const id of ids) ops.push(String(id) === String(op.id) ? op : await cargarOp(id, q))
  return ops.filter(Boolean)
}

const tipoTexto = (op) => L.TIPOS[L.tipoDeOperacion({ tipo_op: op.tipo_op, modalidad: op.modalidad })] || ''

// Calcula (sin escribir) qué pasaría. Devuelve el plan para mostrar y, con `aplicar`, ejecutarlo.
async function planPendiente(idOp, q = query, { soloEsta = false } = {}) {
  const op = await cargarOp(idOp, q)
  const plan = { accion: 'pendiente', idOp: Number(idOp), nroOp: op ? nroOp(op.nro_op) : null, camino: null, puede: false, bloqueos: [], lineas: [],
    saldoAntes: null, saldoDespues: null, remito: op ? op.nro_remito || null : null, opsDelRemito: 1, operaciones: [] }
  const no = (msg) => { plan.bloqueos.push(msg); return plan }
  if (!op) return no('La operación no existe.')
  if (!op.id_cliente) return no('La operación no tiene cliente: no hay cuenta donde volver a cargar la deuda.')
  if (op.estado === 'anulado') return no('La operación está anulada.')
  plan.idCliente = op.id_cliente
  plan.saldoAntes = await saldoDe(op.id_cliente, q)

  const grupo = soloEsta ? [op] : await opsDelRemito(op, q)
  plan.opsDelRemito = grupo.length
  const cuenta = grupo.filter(g => EN_CUENTA.includes(g.metodo_pago))
  const contado = grupo.filter(g => !EN_CUENTA.includes(g.metodo_pago))
  const ec = cuenta.length ? await evaluarCuenta(cuenta, op.id_cliente, q) : null
  const eo = contado.length ? await evaluarContado(contado, q) : null

  plan.bloqueos.push(...(ec ? ec.bloqueos : []), ...(eo ? eo.bloqueos : []))
  if (ec && ec.cambia && eo && eo.cambia) plan.bloqueos.push('Este remito tiene operaciones cobradas de distinta forma (cuenta corriente y contado): marcalas de a una.')
  const cambia = ec && ec.cambia ? ec : (eo && eo.cambia ? eo : null)
  if (!plan.bloqueos.length && !cambia) plan.bloqueos.push((ec && ec.msgYa) || (eo && eo.msgYa) || `${plan.nroOp} ya está pendiente.`)
  plan.camino = cambia === ec && ec ? 'cuenta' : (cambia ? 'contado' : (ec ? 'cuenta' : 'contado'))

  if (cambia) {
    plan.lineas.push(...cambia.lineas)
    if (cambia === ec) {
      if (ec.cambios.some(c => c.tocaMonto && c.montoOriginal - c.montoNuevo > EPS) && Math.abs(ec.delta) > EPS) {
        plan.lineas.push(`El cliente pasa a deber ${pesos(ec.delta)} más en su cuenta corriente.`)
      }
    } else {
      plan.lineas.push(`El cliente pasa a deber ${pesos(eo.delta)} en su cuenta corriente.`)
    }
    plan.saldoDespues = r2(plan.saldoAntes - cambia.delta)
    const afectadas = grupo.filter(g => cambia.quitadoPorOp[g.id] > EPS)
    plan.operaciones = afectadas.map(g => ({ id: Number(g.id), nroOp: nroOp(g.nro_op), tipo: tipoTexto(g), quitado: cambia.quitadoPorOp[g.id] }))
    plan.resumen = {
      quitado: r2(cambia.delta),
      pagosQueCambian: cambia === ec ? ec.cambian : eo.lineas.slice(),
      pagosSinCambio: cambia === ec ? ec.sinCambio : 0,
      operaciones: plan.operaciones,
      otrasOperaciones: cambia === ec ? ec.otras : 0,
    }
    plan._ops = afectadas
    plan._ids = afectadas.map(g => String(g.id))
    plan._cambios = ec && cambia === ec ? ec.cambios : []
    plan._cobros = eo && cambia === eo ? eo.cobros : []
    plan._delta = r2(cambia.delta)
  }
  plan.puede = plan.bloqueos.length === 0 && !!cambia
  return plan
}

// Operaciones del grupo que están en cuenta corriente: qué hay que quitarle a cada pago
async function evaluarCuenta(ops, idCliente, q) {
  const ev = { cambia: false, bloqueos: [], msgYa: null, lineas: [], cambian: [], sinCambio: 0, delta: 0, cambios: [], quitadoPorOp: {}, otras: 0 }
  const unica = ops.length === 1
  if (ops.some(o => o.grupo_todo_junto)) {
    ev.bloqueos.push('Es un alquiler de varios contenedores cobrado todo junto: el pago es uno solo para el grupo. Anulá el pago desde la cuenta corriente del cliente.')
    return ev
  }
  const imp = await ClientesModel.imputacionDe(idCliente, q)
  const conCargo = ops.filter(o => Object.values(imp.cargos).some(c => c.idOp && String(c.idOp) === String(o.id)))
  if (!conCargo.length) {
    ev.msgYa = unica ? `${nroOp(ops[0].nro_op)} todavía no tiene cargo en la cuenta corriente: ya está pendiente.`
      : 'Las operaciones de este remito todavía no tienen cargo en la cuenta corriente: ya están pendientes.'
    return ev
  }
  const asignaciones = await ClientesModel.asignacionesDe([idCliente], q)
  let r
  try { r = calcularReversion(imp.movs, asignaciones, conCargo.map(o => o.id)) } catch (e) { ev.bloqueos.push(e.message); return ev }
  if (!r.cambios.length && r.pagadoAntes <= EPS) {
    ev.msgYa = unica ? `${nroOp(ops[0].nro_op)} ya está pendiente: no tiene pagos aplicados.`
      : 'Las operaciones de este remito ya están pendientes: no tienen pagos aplicados.'
    return ev
  }

  const ids = new Set(conCargo.map(o => String(o.id)))
  const pagadoPorOp = porOperacion(imp.cargos)
  conCargo.forEach(o => { ev.quitadoPorOp[o.id] = r2(pagadoPorOp[String(o.id)] ? pagadoPorOp[String(o.id)].pagado : 0) })
  ev.otras = new Set(Object.values(imp.cargos).filter(c => c.idOp && !ids.has(String(c.idOp))).map(c => String(c.idOp))).size

  const movs = new Map(imp.movs.map(m => [String(m.id), m]))
  for (const c of r.cambios) {
    const m = movs.get(String(c.idPago))
    const cheque = (await q(`SELECT 1 FROM cheques WHERE id_mov_cuenta = ? LIMIT 1`, [c.idPago])).rows[0]
    const tercero = (await q(`SELECT 1 FROM egresos WHERE id_movimiento_cuenta = ? LIMIT 1`, [c.idPago])).rows[0]
    const desc = `el pago del ${fechaCorta(m.created_at)} por ${pesos(m.monto)}${m.metodo_pago ? ` (${METODO_TXT[m.metodo_pago] || m.metodo_pago})` : ''}`
    const esta = unica ? 'esta operación' : 'estas operaciones'
    if (cheque) ev.bloqueos.push(`Parte de lo pagado viene de ${desc}, que es un cheque: deshabilitá el cheque desde Cheques y volvé a intentar.`)
    else if (tercero && c.tocaMonto && c.montoNuevo > EPS) ev.bloqueos.push(`Parte de lo pagado viene de ${desc}, una transferencia a un tercero que también paga otras operaciones: anulalo entero desde la cuenta corriente (Anular) y volvé a registrar lo que corresponda.`)
    else if (c.montoNuevo <= EPS) { const t = `Se anula ${desc}: era todo de ${esta}.`; ev.lineas.push(t); ev.cambian.push(t) }
    else if (c.tocaMonto) {
      const t = `Del ${desc.replace(/^el /, '')}, ${pesos(c.montoOriginal - c.montoNuevo)} eran de ${esta}: se anula y se vuelve a registrar por los ${pesos(c.montoNuevo)} que corresponden a las demás.`
      ev.lineas.push(t); ev.cambian.push(t)
    } else { ev.lineas.push(`${desc[0].toUpperCase()}${desc.slice(1)} se mantiene, pero se deja escrito a qué operaciones va.`); ev.sinCambio++ }
    ev.delta += c.montoOriginal - c.montoNuevo
  }
  ev.delta = r2(ev.delta)
  ev.cambios = r.cambios
  ev.cambia = true
  return ev
}

// Operaciones del grupo cobradas de contado: el cobro pasa a cuenta corriente
async function evaluarContado(ops, q) {
  const ev = { cambia: false, bloqueos: [], msgYa: null, lineas: [], delta: 0, cobros: [], quitadoPorOp: {} }
  const unica = ops.length === 1
  const de = (o, texto) => (unica ? texto : `${nroOp(o.nro_op)}: ${texto}`)
  let sinCobro = 0
  for (const o of ops) {
    const cobros = await cobrosDeContado(o.id, q)
    if (!cobros.length) { sinCobro++; continue }
    if (cobros.length > 1) { ev.bloqueos.push(de(o, 'Tiene más de un cobro registrado: pasá cada uno a cuenta corriente desde Transacciones (Cambiar método de pago).')); continue }
    const c = cobros[0]
    if (!COBRO_CONTADO.includes(c.metodo_pago || 'efectivo')) { ev.bloqueos.push(de(o, `El cobro es con ${c.metodo_pago}: anulalo desde Cheques.`)); continue }
    if (o.grupo_todo_junto) { ev.bloqueos.push(de(o, 'Es un alquiler de varios contenedores cobrado todo junto: el método de pago no se puede cambiar por separado.')); continue }
    const errCC = await ClientesModel.errorCuentaCorriente(o.id_cliente)
    if (errCC) { ev.bloqueos.push(de(o, `Para dejarla pendiente el cobro pasa a la cuenta corriente del cliente, y no se puede: ${errCC}`)); continue }
    ev.lineas.push(`El cobro de ${pesos(c.monto)} (${METODO_TXT[c.metodo_pago || 'efectivo']}, ${fechaCorta(c.fecha)}) pasa a cuenta corriente.`)
    ev.cobros.push({ op: o, cobro: c })
    ev.quitadoPorOp[o.id] = r2(c.monto)
    ev.delta += Number(c.monto)
  }
  ev.delta = r2(ev.delta)
  ev.cambia = ev.cobros.length > 0
  if (!ev.cambia && sinCobro === ops.length) {
    ev.msgYa = unica ? `${nroOp(ops[0].nro_op)} no tiene ningún cobro registrado: ya está pendiente.`
      : 'Las operaciones de este remito no tienen ningún cobro registrado: ya están pendientes.'
  }
  return ev
}

// Lo que se le quita a una operación y sus datos para mostrar (sin las claves internas "_")
const publico = (plan) => Object.fromEntries(Object.entries(plan).filter(([k]) => !k.startsWith('_')))

async function vistaPreviaPendiente(idOp, opciones = {}) { return publico(await planPendiente(idOp, query, opciones)) }

async function marcarPendiente(idOp, { usuario = null, motivo = '', soloEsta = false } = {}) {
  const texto = String(motivo || '').trim().slice(0, 300)
  if (texto.length < 3) throw new Error('Indicá el motivo.')
  const op = await cargarOp(idOp)
  if (!op) throw new Error('La operación no existe.')

  const previo = await planPendiente(idOp, query, { soloEsta })
  if (!previo.puede) throw new Error(previo.bloqueos[0] || 'No se puede dejar pendiente.')

  if (previo.camino === 'cuenta') {
    const resultado = await transaction(async (q) => {
      await q(`SELECT id FROM clientes WHERE id = ? FOR UPDATE`, [op.id_cliente])
      const plan = await planPendiente(idOp, q, { soloEsta })
      if (!plan.puede) throw new Error(plan.bloqueos[0] || 'No se puede dejar pendiente.')
      const antes = imputacionActual(await ClientesModel.imputacionDe(op.id_cliente, q))
      const rotulo = plan._ops.map(o => nroOp(o.nro_op)).join(', ')
      for (const c of plan._cambios) await aplicarCambio(c, { idCliente: op.id_cliente, rotulo }, { usuario, motivo: texto }, q)
      await verificarCuenta(op.id_cliente, plan, antes, q)
      return plan
    })
    for (const o of resultado._ops) {
      await auditar('marcar_pendiente', o, usuario, { camino: 'cuenta', motivo: texto, remito: resultado.remito, operaciones: resultado.operaciones.map(x => x.nroOp),
        cambios: resultado._cambios, saldoAntes: resultado.saldoAntes, saldoDespues: resultado.saldoDespues })
    }
    return publico(resultado)
  }

  // De contado: cada cobro pasa a cuenta corriente; si algo no cierra, se vuelve todo atrás
  const plan = previo
  const TransaccionesModel = require('./transacciones.model')
  const hechos = []
  try {
    for (const { cobro } of plan._cobros) {
      await TransaccionesModel.cambiarMetodoPago(cobro.id, 'cuenta_corriente')
      hechos.push(cobro)
    }
    const pagado = await ClientesModel.pagadoPorOperacion(plan._ids)
    const saldo = await saldoDe(op.id_cliente)
    if (plan._ids.some(id => !pagado[id] || pagado[id].pagado > EPS) || Math.abs(saldo - plan.saldoDespues) > 0.01) {
      throw new Error('El cambio no dejó la operación pendiente como se esperaba.')
    }
  } catch (e) {
    for (const c of hechos.reverse()) await TransaccionesModel.cambiarMetodoPago(c.id, c.metodo_pago || 'efectivo').catch(() => {})
    throw new Error(`${e.message} Se volvió al estado anterior.`)
  }
  for (const { op: o, cobro } of plan._cobros) {
    await auditar('marcar_pendiente', o, usuario, { camino: 'contado', motivo: texto, remito: plan.remito, operaciones: plan.operaciones.map(x => x.nroOp),
      transaccion: cobro.id, monto: Number(cobro.monto), metodoAnterior: cobro.metodo_pago || 'efectivo', saldoAntes: plan.saldoAntes, saldoDespues: plan.saldoDespues })
  }
  return publico(plan)
}

// Lo que importa comparar antes / después: pagado por operación y restante de los cargos a mano
function imputacionActual(imp) {
  return {
    ops: porOperacion(imp.cargos),
    sueltos: Object.fromEntries(Object.entries(imp.cargos).filter(([, c]) => !c.idOp).map(([id, c]) => [id, c.restante])),
  }
}

// Anula el pago afectado (queda en el historial) y, si sobra plata para otras operaciones, lo
// registra de nuevo por esa parte (misma fecha, método y descripción) con sus operaciones escritas
async function aplicarCambio(c, { idCliente, rotulo }, { usuario, motivo }, q) {
  const m = (await q(`SELECT * FROM movimientos_cuenta WHERE id = ? AND cliente_id = ? FOR UPDATE`, [c.idPago, idCliente])).rows[0]
  if (!m || Number(m.anulado)) throw new Error('Un pago cambió mientras se calculaba. Volvé a intentar.')
  if (Math.abs(Number(m.monto) - c.montoOriginal) > 0.005) throw new Error('Un pago cambió mientras se calculaba. Volvé a intentar.')
  if (!c.tocaMonto) {
    // Mismo pago: solo se deja escrito a qué operaciones va
    await q(`DELETE FROM imputaciones_pago WHERE id_pago = ?`, [c.idPago])
    await ClientesModel.guardarImputaciones(c.idPago, c.imputaciones, q)
    return
  }
  const razon = `Marcada pendiente ${rotulo}: ${motivo}`
  await q(`UPDATE movimientos_cuenta SET anulado = 1, anulado_en = ahora_local(), anulado_por = ?, anulado_motivo = ? WHERE id = ?`,
    [usuario || null, razon.slice(0, 300), c.idPago])
  await require('../services/tercero.service').borrarDeMovimiento(c.idPago, q)
  if (c.montoNuevo > EPS) {
    const nuevo = await ClientesModel.agregarMovimiento(idCliente, {
      tipo: m.tipo, descripcion: `${m.descripcion || 'Pago'} (resto tras marcar pendiente ${rotulo})`.slice(0, 300),
      monto: c.montoNuevo, metodo_pago: m.metodo_pago, fecha: m.created_at,
    }, q)
    await ClientesModel.guardarImputaciones(nuevo, c.imputaciones, q)
  }
}

// Antes de confirmar: las operaciones marcadas quedaron sin pagos, NINGUNA otra operación ni cargo
// a mano del cliente cambió y el saldo se movió exactamente lo esperado. Si no, no se guarda nada.
async function verificarCuenta(idCliente, plan, antes, q) {
  const imp = await ClientesModel.imputacionDe(idCliente, q)
  const ahora = imputacionActual(imp)
  const marcadas = new Set(plan._ids.map(String))
  for (const id of marcadas) {
    const x = ahora.ops[id]
    if (x && x.pagado > EPS) throw new Error('Verificación: la operación seguía con pagos aplicados. No se guardó nada.')
  }
  for (const id of new Set([...Object.keys(antes.ops), ...Object.keys(ahora.ops)])) {
    if (marcadas.has(id)) continue
    if (Math.abs((antes.ops[id] ? antes.ops[id].pagado : 0) - (ahora.ops[id] ? ahora.ops[id].pagado : 0)) > 0.01) {
      throw new Error('Verificación: el cambio alteraba el pago de otra operación del cliente. No se guardó nada.')
    }
  }
  for (const id of Object.keys(antes.sueltos)) {
    if (Math.abs(antes.sueltos[id] - (ahora.sueltos[id] ?? antes.sueltos[id])) > 0.01) throw new Error('Verificación: el cambio alteraba un cargo a mano del cliente. No se guardó nada.')
  }
  const saldo = await saldoDe(idCliente, q)
  if (Math.abs(saldo - plan.saldoDespues) > 0.01) throw new Error(`Verificación: el saldo quedó en ${pesos(saldo)} y se esperaba ${pesos(plan.saldoDespues)}. No se guardó nada.`)
}

// ── Marcar PAGADA ─────────────────────────────────────────────────────
//  · En cuenta corriente: se registra un pago por lo que falta de la operación, aplicado a ella.
//  · De contado (venta entregada sin cobro): se registra el cobro por lo que falta.

async function planPagada(idOp, { metodo_pago = 'efectivo' } = {}, q = query) {
  const op = await cargarOp(idOp, q)
  const plan = { accion: 'pagada', idOp: Number(idOp), nroOp: op ? nroOp(op.nro_op) : null, camino: null, puede: false, bloqueos: [], lineas: [], saldoAntes: null, saldoDespues: null, monto: 0 }
  const no = (msg) => { plan.bloqueos.push(msg); return plan }
  if (!op) return no('La operación no existe.')
  if (!op.id_cliente) return no('La operación no tiene cliente.')
  if (op.estado === 'anulado') return no('La operación está anulada.')
  plan.idCliente = op.id_cliente
  if (EN_CUENTA.includes(op.metodo_pago)) return planPagadaCuenta(op, plan, metodo_pago, q)
  plan.camino = 'contado'
  if (!COBRO_CONTADO.includes(metodo_pago)) return no('Elegí efectivo o transferencia. Los cheques se registran desde Cheques.')
  if (op.grupo_todo_junto) return no('Es un alquiler de varios contenedores cobrado todo junto: se cobra desde su grupo.')
  if (['pendiente', 'despachado'].includes(op.estado)) return no('Todavía no se entregó: se cobra al entregarla.')
  const o = await require('./liquidaciones.model').operacion(op.id)
  if (!o) return no('No se pudo calcular el importe de la operación.')
  if (o.aConvenir) return no('Tiene el precio a convenir: primero asignale el precio (Cobranzas).')
  if (o.enCurso || o.estimado) return no('Es un alquiler todavía en curso: el importe se conoce y se cobra al retirar el contenedor.')
  if (o.estado === 'pagada') return no(`${plan.nroOp} ya está pagada.`)
  plan.monto = r2(o.resta)
  plan.saldoAntes = await saldoDe(op.id_cliente)
  plan.saldoDespues = plan.saldoAntes
  plan.lineas.push(`Se registra un cobro de ${pesos(plan.monto)} en ${METODO_TXT[metodo_pago]}.`)
  plan.puede = plan.monto > EPS
  if (!plan.puede) plan.bloqueos.push('No hay importe pendiente.')
  plan._op = op
  return plan
}

// Operación en cuenta corriente: un pago por lo que le falta, aplicado a ella
async function planPagadaCuenta(op, plan, metodo_pago, q) {
  plan.camino = 'cuenta'
  const no = (msg) => { plan.bloqueos.push(msg); return plan }
  if (!COBRO_CONTADO.includes(metodo_pago)) return no('Elegí efectivo o transferencia. Los cheques se registran desde Cheques.')
  if (op.grupo_todo_junto) return no('Es un alquiler de varios contenedores cobrado todo junto: el pago es uno solo para el grupo. Registralo desde la cuenta corriente del cliente.')
  const imp = await ClientesModel.imputacionDe(op.id_cliente, q)
  const cargos = Object.values(imp.cargos).filter(c => c.idOp && String(c.idOp) === String(op.id))
  if (!cargos.length) return no(`${plan.nroOp} todavía no tiene cargo en la cuenta corriente (se carga al entregarla o cobrarla): todavía no hay nada que pagar.`)
  const item = (await ClientesModel.pendientesDeCobro(op.id_cliente, q, imp)).find(it => it.clave === `op:${op.id}`)
  if (!item) return no(`${plan.nroOp} ya está pagada.`)
  plan.monto = r2(item.resta)
  plan.saldoAntes = await saldoDe(op.id_cliente, q)
  plan.saldoDespues = r2(plan.saldoAntes + plan.monto)
  plan.lineas.push(`Se registra un pago de ${pesos(plan.monto)} en ${METODO_TXT[metodo_pago]}, aplicado a esta operación (lo que le falta).`)
  plan.puede = plan.monto > EPS
  if (!plan.puede) plan.bloqueos.push('No hay importe pendiente.')
  return plan
}

async function vistaPreviaPagada(idOp, opts) { return publico(await planPagada(idOp, opts)) }

async function marcarPagada(idOp, { usuario = null, metodo_pago = 'efectivo', fechaDia = null } = {}) {
  const { fechaHoraDePago } = require('../utils/fechaPago')
  const op0 = await cargarOp(idOp)
  if (op0 && EN_CUENTA.includes(op0.metodo_pago)) return marcarPagadaCuenta(op0, { usuario, metodo_pago, fechaDia })
  const plan = await planPagada(idOp, { metodo_pago })
  if (!plan.puede) throw new Error(plan.bloqueos[0] || 'No se puede marcar como pagada.')
  const op = plan._op
  const TransaccionesModel = require('./transacciones.model')
  const tipo = op.tipo_op === 'M' ? (op.modalidad === 'flete' ? 'Venta Viaje' : 'Venta Cantera') : op.tipo_op === 'C' ? 'Alquiler' : 'Maquinaria'
  await transaction(async (q) => {
    await TransaccionesModel.crear({
      tipo, id_op_encabezado: op.id, nro_remito: op.nro_remito, cliente_id: op.id_cliente, monto: plan.monto,
      descripcion: `Cobro registrado manualmente — ${plan.nroOp}`, metodo_pago, fecha: fechaDia ? fechaHoraDePago(fechaDia) : null,
    }, q)
    // El método de la operación acompaña al del cobro (como al cambiarlo en Transacciones)
    if (op.metodo_pago !== metodo_pago) {
      await q(`UPDATE op_encabezado SET metodo_pago = ? WHERE id = ?`, [metodo_pago, op.id])
      if (op.tipo_op === 'C') await q(`UPDATE op_detalle_contenedor SET metodo_pago = ? WHERE id_orden_pedido = ?`, [metodo_pago, op.id])
      if (op.tipo_op === 'MA') await q(`UPDATE op_detalle_maquinaria SET metodo_pago = ? WHERE id_orden_pedido = ?`, [metodo_pago, op.id])
    }
    const cobrado = (await q(`SELECT COALESCE(SUM(monto), 0) AS s FROM transacciones WHERE id_op_encabezado = ? AND tipo <> 'Ajuste' AND NOT (COALESCE(metodo_pago, 'efectivo') = ANY(?))`, [op.id, SIN_COBRO])).rows[0].s
    if (Number(cobrado) < Number(plan.monto) - 0.01) throw new Error('Verificación: el cobro no quedó registrado. No se guardó nada.')
  })
  await auditar('marcar_pagada', op, usuario, { camino: 'contado', monto: plan.monto, metodo_pago, fecha: fechaDia })
  return publico(plan)
}

async function marcarPagadaCuenta(op, { usuario, metodo_pago, fechaDia }) {
  const { fechaHoraDePago } = require('../utils/fechaPago')
  const plan = await transaction(async (q) => {
    await q(`SELECT id FROM clientes WHERE id = ? FOR UPDATE`, [op.id_cliente])
    const plan = await planPagada(op.id, { metodo_pago }, q)
    if (!plan.puede) throw new Error(plan.bloqueos[0] || 'No se puede marcar como pagada.')
    const antes = imputacionActual(await ClientesModel.imputacionDe(op.id_cliente, q))
    const elegidas = await ClientesModel.validarImputaciones(op.id_cliente, [{ clave: `op:${op.id}`, monto: plan.monto }], plan.monto, q)
    const mov = await ClientesModel.agregarMovimiento(op.id_cliente, {
      tipo: 'pago', descripcion: `Pago — ${plan.nroOp} (marcada como pagada)`, monto: plan.monto, metodo_pago, fecha: fechaHoraDePago(fechaDia),
    }, q)
    await ClientesModel.guardarImputaciones(mov, elegidas, q)
    // Verificación: la operación quedó pagada, ninguna otra cambió y el saldo subió lo que se pagó
    const ahora = imputacionActual(await ClientesModel.imputacionDe(op.id_cliente, q))
    const x = ahora.ops[String(op.id)]
    if (!x || x.total - x.pagado > 0.01) throw new Error('Verificación: la operación no quedó pagada. No se guardó nada.')
    for (const id of new Set([...Object.keys(antes.ops), ...Object.keys(ahora.ops)])) {
      if (id === String(op.id)) continue
      if (Math.abs((antes.ops[id] ? antes.ops[id].pagado : 0) - (ahora.ops[id] ? ahora.ops[id].pagado : 0)) > 0.01) throw new Error('Verificación: el pago alteraba otra operación del cliente. No se guardó nada.')
    }
    const saldo = await saldoDe(op.id_cliente, q)
    if (Math.abs(saldo - plan.saldoDespues) > 0.01) throw new Error(`Verificación: el saldo quedó en ${pesos(saldo)} y se esperaba ${pesos(plan.saldoDespues)}. No se guardó nada.`)
    return plan
  })
  await auditar('marcar_pagada', op, usuario, { camino: 'cuenta', monto: plan.monto, metodo_pago, fecha: fechaDia, saldoAntes: plan.saldoAntes, saldoDespues: plan.saldoDespues })
  return publico(plan)
}

async function auditar(accion, op, usuario, detalle) {
  await require('../utils/auditoria').registrarAuditoria({
    entidad_tipo: 'operacion', entidad_id: op.id, accion, usuario,
    detalle: { cliente_id: op.id_cliente, nro_op: op.nro_op, ...detalle },
  })
}

module.exports = {
  calcularReversion, planPendiente, vistaPreviaPendiente, marcarPendiente,
  planPagada, vistaPreviaPagada, marcarPagada,
}
