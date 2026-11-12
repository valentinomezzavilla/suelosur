'use strict'
// ═══════════════════════════════════════════════════════════════════
// Imputación de pagos de la cuenta corriente: regla ÚNICA (lógica pura, sin base).
// La usan el estado de cuenta ("Saldar", "Saldado"), Liquidaciones, el saldo del cliente y
// Transacciones (venta saldada / sin saldar), así cada módulo dice lo mismo de cada cargo.
//
// En este orden:
//  1. Un ajuste a favor de una operación (id_op_encabezado, p. ej. se le quitó el IVA) baja
//     lo que debe ESA operación: es una rebaja de su precio, no un pago.
//  2. Un pago se aplica a las operaciones (o cargos a mano) que se eligieron al registrarlo
//     (`asignaciones`, tabla imputaciones_pago), hasta lo que deba cada una.
//  3. Lo que no se eligió, en el orden de la cuenta (fecha y, a igual fecha, orden de carga):
//     cubre los cargos más viejos primero (FIFO) y lo que sobra queda a favor. Un cargo
//     (deuda, uso de saldo a favor, ajuste en contra) se cubre primero con el saldo a favor
//     que ya hubiera; si no alcanza, lo que falta queda como deuda.
//
// Invariante: Σ restante de los cargos − aFavor = −Σ montos = deuda de la cuenta.
// ═══════════════════════════════════════════════════════════════════

const EPS = 1e-6
const r2 = (n) => Math.round(n * 100) / 100
const k = (v) => String(v)

// movs: [{ id, monto, tipo, id_op_encabezado, created_at?, descripcion?, metodo_pago? }] de UN
//   cliente, ya ordenados y sin anulados.
// asignaciones: [{ id_pago, id_op_encabezado?, id_cargo?, monto }] (las de pagos que no estén
//   en movs, p. ej. anulados, no cuentan).
// → { cargos, aFavor, creditos, aplicaciones }
//   cargos: { [id]: { idOp, total, restante, creditoPropio, usoSaldo? } }; creditoPropio: lo
//     que le bajaron al cargo los ajustes a favor de su misma operación.
//   creditos: los pagos / ajustes con algo sin aplicar (de dónde sale el saldo a favor), del
//     más viejo al más nuevo: [{ id, fecha, tipo, descripcion, metodo_pago, monto, sobrante }].
//   aplicaciones: { [id del pago]: [{ idCargo, idOp, monto, elegida }] } a qué se aplicó cada
//     pago (elegida: lo eligió quien lo registró; si no, fue a lo más viejo).
function imputar(movs, asignaciones = []) {
  const lista = movs || []
  const cargos = {}
  const porOp = new Map()
  for (const m of lista) {
    const monto = Number(m.monto) || 0
    if (monto >= 0) continue
    const c = { idOp: m.id_op_encabezado || null, total: -monto, restante: -monto, creditoPropio: 0 }
    if (m.tipo === 'uso_saldo_favor') c.usoSaldo = true
    c._id = m.id
    cargos[m.id] = c
    if (c.idOp) {
      if (!porOp.has(k(c.idOp))) porOp.set(k(c.idOp), [])
      porOp.get(k(c.idOp)).push(c)
    }
  }

  const aplicaciones = {}
  const anotar = (idPago, c, monto, elegida) => {
    if (monto <= EPS) return
    const lista = aplicaciones[idPago] ||= []
    const previa = lista.find(a => k(a.idCargo) === k(c._id) && a.elegida === elegida)
    if (previa) previa.monto += monto
    else lista.push({ idCargo: c._id, idOp: c.idOp, monto, elegida })
  }
  // Cubre `destino` (cargos en orden) con hasta `disponible`; devuelve lo que sobra
  const cubrir = (destino, disponible, idPago, { propio = false, elegida = false } = {}) => {
    for (const c of destino) {
      if (disponible <= EPS) break
      const usado = Math.min(disponible, c.restante)
      if (usado <= EPS) continue
      c.restante -= usado
      disponible -= usado
      if (propio) c.creditoPropio += usado
      else anotar(idPago, c, usado, elegida)
    }
    return disponible
  }

  // 1) Ajustes a favor de una operación: bajan esa operación
  const libre = {}
  for (const m of lista) {
    const monto = Number(m.monto) || 0
    if (monto <= 0) continue
    libre[k(m.id)] = m.id_op_encabezado ? cubrir(porOp.get(k(m.id_op_encabezado)) || [], monto, m.id, { propio: true }) : monto
  }

  // 2) Lo que se eligió al registrar cada pago
  for (const a of asignaciones || []) {
    const idPago = k(a.id_pago)
    if (!(idPago in libre)) continue
    const pedido = Math.min(Number(a.monto) || 0, libre[idPago])
    if (pedido <= EPS) continue
    const destino = a.id_cargo != null ? (cargos[a.id_cargo] ? [cargos[a.id_cargo]] : []) : (porOp.get(k(a.id_op_encabezado)) || [])
    libre[idPago] -= pedido - cubrir(destino, pedido, a.id_pago, { elegida: true })
  }

  // 3) El resto, en el orden de la cuenta: a lo más viejo primero; lo que sobra queda a favor
  const cola = []
  const creditos = []
  const usarAFavor = (c) => {
    while (c.restante > EPS && creditos.length) {
      const cr = creditos[0]
      const usado = Math.min(cr.sobrante, c.restante)
      cr.sobrante -= usado
      c.restante -= usado
      anotar(cr.id, c, usado, false)
      if (cr.sobrante <= EPS) creditos.shift()
    }
  }
  for (const m of lista) {
    const monto = Number(m.monto) || 0
    if (monto < 0) {
      const c = cargos[m.id]
      usarAFavor(c)
      if (c.restante > EPS) cola.push(c)
    } else if (monto > 0) {
      const sobra = cubrir(cola, libre[k(m.id)], m.id)
      for (let i = cola.length - 1; i >= 0; i--) if (cola[i].restante <= EPS) cola.splice(i, 1)
      if (sobra > EPS) {
        creditos.push({
          id: m.id, fecha: m.created_at || null, tipo: m.tipo || null, descripcion: m.descripcion || '',
          metodo_pago: m.metodo_pago || null, monto, sobrante: sobra,
        })
      }
    }
  }

  for (const c of Object.values(cargos)) {
    c.total = r2(c.total)
    c.restante = r2(Math.max(0, c.restante))
    c.creditoPropio = r2(c.creditoPropio)
    delete c._id
  }
  for (const lista of Object.values(aplicaciones)) lista.forEach(a => { a.monto = r2(a.monto) })
  const sinAplicar = creditos.map(cr => ({ ...cr, sobrante: r2(cr.sobrante) })).filter(cr => cr.sobrante > 0)
  const aFavor = r2(sinAplicar.reduce((s, cr) => s + cr.sobrante, 0))
  return { cargos, aFavor, creditos: sinAplicar, aplicaciones }
}

// Por operación: { [idOp]: { total, pagado } }. Una OP puede tener más de un cargo (p. ej. el
// IVA sumado al marcarla para facturar); el total es lo que se le cargó menos los ajustes a
// favor de la misma operación (el IVA que se le quitó). Las pagadas con saldo a favor figuran
// pagadas en lo que el crédito alcanzó.
function porOperacion(cargos) {
  const res = {}
  for (const c of Object.values(cargos)) {
    if (!c.idOp) continue
    const d = res[c.idOp] ||= { total: 0, pagado: 0 }
    const neto = c.total - (c.creditoPropio || 0)
    d.total += neto
    d.pagado += neto - c.restante
  }
  for (const d of Object.values(res)) { d.total = r2(d.total); d.pagado = r2(Math.max(0, d.pagado)) }
  return res
}

module.exports = { imputar, porOperacion }
