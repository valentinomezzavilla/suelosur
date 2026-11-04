'use strict'
// ═══════════════════════════════════════════════════════════════════
// Imputación de pagos de la cuenta corriente: regla ÚNICA (lógica pura, sin base).
// La usan el estado de cuenta ("Saldar", "Saldado"), Liquidaciones y Transacciones
// (venta saldada / sin saldar), así cada módulo dice lo mismo de cada cargo.
//
// No hay un vínculo pago ↔ venta: los pagos se aplican a los cargos más viejos primero
// (FIFO), en el orden de la cuenta (fecha y, a igual fecha, orden de carga).
//
//  · Cargo (monto < 0: deuda, ajuste en contra): entra en la cola. Si hay saldo a favor
//    acumulado (pagos adelantados), se cubre primero con él.
//  · Pago o ajuste a favor (monto > 0): cubre la cola; lo que sobra queda a favor.
//  · Uso de saldo a favor (venta pagada con crédito): consume el crédito acumulado y no es
//    deuda. Si el crédito no alcanzara (datos viejos), lo que falta queda como deuda.
//
// Invariante: Σ restante de los cargos − aFavor = −Σ montos = deuda de la cuenta.
// ═══════════════════════════════════════════════════════════════════

const EPS = 1e-6
const r2 = (n) => Math.round(n * 100) / 100

// movs: [{ id, monto, tipo, id_op_encabezado }] de UN cliente, ya ordenados y sin anulados.
// → { cargos: { [id]: { idOp, total, restante } }, aFavor }
function imputar(movs) {
  const cargos = {}
  const cola = []
  let aFavor = 0
  const encolar = (m, importe) => {
    const c = { idOp: m.id_op_encabezado || null, total: importe, restante: importe }
    const usado = Math.min(aFavor, c.restante)
    c.restante -= usado
    aFavor -= usado
    cargos[m.id] = c
    if (c.restante > EPS) cola.push(c)
  }
  for (const m of movs || []) {
    const monto = Number(m.monto) || 0
    if (monto < 0 && m.tipo === 'uso_saldo_favor') {
      const importe = -monto
      const usado = Math.min(aFavor, importe)
      aFavor -= usado
      const c = { idOp: m.id_op_encabezado || null, total: importe, restante: importe - usado, usoSaldo: true }
      cargos[m.id] = c
      if (c.restante > EPS) cola.push(c)
    } else if (monto < 0) {
      encolar(m, -monto)
    } else if (monto > 0) {
      let disponible = monto
      while (disponible > EPS && cola.length) {
        const cabeza = cola[0]
        const usado = Math.min(disponible, cabeza.restante)
        cabeza.restante -= usado
        disponible -= usado
        if (cabeza.restante <= EPS) cola.shift()
      }
      aFavor += disponible
    }
  }
  for (const c of Object.values(cargos)) { c.total = r2(c.total); c.restante = r2(Math.max(0, c.restante)) }
  return { cargos, aFavor: r2(aFavor) }
}

// Por operación: { [idOp]: { total, pagado } }. Una OP puede tener más de un cargo
// (p. ej. el IVA sumado al marcarla para facturar). Las ventas pagadas con saldo a favor
// figuran como pagadas.
function porOperacion(cargos) {
  const res = {}
  for (const c of Object.values(cargos)) {
    if (!c.idOp) continue
    const d = res[c.idOp] ||= { total: 0, pagado: 0 }
    d.total += c.total
    d.pagado += c.total - c.restante
  }
  for (const d of Object.values(res)) { d.total = r2(d.total); d.pagado = r2(d.pagado) }
  return res
}

module.exports = { imputar, porOperacion }
