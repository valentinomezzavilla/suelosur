'use strict'
// Qué botones de estado de pago corresponden a una operación (lógica pura, sin base).
// `o`: una operación armada por Liquidaciones (estado de pago, método, si está en la cuenta…).
// Los usan todos los módulos que muestran operaciones (Ventas, Transacciones, Alquileres…).
//
//  · Marcar pendiente: la que figura pagada o con algo pagado.
//  · Marcar como pagada: la que debe algo y ya se puede cobrar: en cuenta corriente, con su
//    cargo en la cuenta; de contado, ya entregada (un alquiler en curso se cobra al retirar el
//    contenedor, y lo que no se entregó, al entregarla).
const EN_CUENTA = ['cuenta_corriente', 'saldo_a_favor']
const SIN_ENTREGAR = ['pendiente', 'despachado']
const CENTAVO = 0.005

function accionesDe(o) {
  const nada = { pendiente: false, pagada: false }
  if (!o || o.aConvenir || o.estado === 'a_convenir' || o.estadoOp === 'anulado') return nada
  const pendiente = (o.estado === 'pagada' || o.estado === 'parcial') && !o.estimado
  const debe = (o.estado === 'pendiente' || o.estado === 'parcial') && Number(o.resta) > CENTAVO
  const listaParaCobrar = !o.grupoTodoJunto && !o.estimado && !o.enCurso
  const pagada = debe && listaParaCobrar
    && (o.enCuenta || (!EN_CUENTA.includes(o.metodo_pago) && !SIN_ENTREGAR.includes(o.estadoOp)))
  return { pendiente, pagada }
}

module.exports = { accionesDe }
