'use strict'
// ═══════════════════════════════════════════════════════════════════
// Imputación de pagos de la cuenta corriente: regla ÚNICA (lógica pura, sin base).
// La usan el estado de cuenta ("Saldar", "Saldado"), Liquidaciones, el saldo del cliente y
// Transacciones (venta saldada / sin saldar), así cada módulo dice lo mismo de cada cargo.
//
// No hay un vínculo pago ↔ venta: los pagos se aplican a los cargos más viejos primero
// (FIFO), en el orden de la cuenta (fecha y, a igual fecha, orden de carga).
//
//  · Cargo (monto < 0: deuda, ajuste en contra): entra en la cola. Si hay saldo a favor
//    acumulado (pagos adelantados), se cubre primero con él.
//  · Uso de saldo a favor (venta pagada con crédito): igual que un cargo: consume el crédito
//    acumulado. Si el crédito no alcanzara, lo que falta queda como deuda.
//  · Pago o ajuste a favor (monto > 0): cubre la cola; lo que sobra queda a favor. Si es de
//    una operación (un ajuste con id_op_encabezado, p. ej. se le quitó el IVA), primero baja
//    lo que debe ESA operación: es una rebaja de su precio, no un pago para la deuda más vieja.
//
// Invariante: Σ restante de los cargos − aFavor = −Σ montos = deuda de la cuenta.
// ═══════════════════════════════════════════════════════════════════

const EPS = 1e-6
const r2 = (n) => Math.round(n * 100) / 100

// movs: [{ id, monto, tipo, id_op_encabezado, created_at?, descripcion?, metodo_pago? }] de UN
// cliente, ya ordenados y sin anulados.
// → { cargos: { [id]: { idOp, total, restante, creditoPropio, usoSaldo? } }, aFavor, creditos }
//   creditoPropio: lo que le bajaron al cargo los ajustes a favor de su misma operación.
//   creditos: los pagos / ajustes que todavía tienen algo sin aplicar (de dónde sale el saldo
//   a favor), del más viejo al más nuevo: [{ id, fecha, tipo, descripcion, metodo_pago, monto, sobrante }].
function imputar(movs) {
  const cargos = {}
  const cola = []
  const creditos = []

  // Usa el saldo a favor acumulado, del crédito más viejo al más nuevo. Devuelve lo usado.
  const usarAFavor = (importe) => {
    let usado = 0
    while (importe - usado > EPS && creditos.length) {
      const cr = creditos[0]
      const u = Math.min(cr.sobrante, importe - usado)
      cr.sobrante -= u
      usado += u
      if (cr.sobrante <= EPS) creditos.shift()
    }
    return usado
  }
  const aplicar = (c, disponible) => {
    const usado = Math.min(disponible, c.restante)
    c.restante -= usado
    return usado
  }

  for (const m of movs || []) {
    const monto = Number(m.monto) || 0
    if (monto < 0) {
      const importe = -monto
      const c = { idOp: m.id_op_encabezado || null, total: importe, restante: importe, creditoPropio: 0 }
      if (m.tipo === 'uso_saldo_favor') c.usoSaldo = true
      c.restante -= usarAFavor(importe)
      cargos[m.id] = c
      if (c.restante > EPS) cola.push(c)
    } else if (monto > 0) {
      let disponible = monto
      if (m.id_op_encabezado) {
        for (const c of cola) {
          if (disponible <= EPS) break
          if (String(c.idOp) !== String(m.id_op_encabezado)) continue
          const usado = aplicar(c, disponible)
          c.creditoPropio += usado
          disponible -= usado
        }
      }
      for (const c of cola) {
        if (disponible <= EPS) break
        disponible -= aplicar(c, disponible)
      }
      for (let i = cola.length - 1; i >= 0; i--) if (cola[i].restante <= EPS) cola.splice(i, 1)
      if (disponible > EPS) {
        creditos.push({
          id: m.id, fecha: m.created_at || null, tipo: m.tipo || null, descripcion: m.descripcion || '',
          metodo_pago: m.metodo_pago || null, monto, sobrante: disponible,
        })
      }
    }
  }
  for (const c of Object.values(cargos)) {
    c.total = r2(c.total)
    c.restante = r2(Math.max(0, c.restante))
    c.creditoPropio = r2(c.creditoPropio)
  }
  const sinAplicar = creditos.map(cr => ({ ...cr, sobrante: r2(cr.sobrante) })).filter(cr => cr.sobrante > 0)
  const aFavor = r2(sinAplicar.reduce((s, cr) => s + cr.sobrante, 0))
  return { cargos, aFavor, creditos: sinAplicar }
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
