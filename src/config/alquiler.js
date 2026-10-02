'use strict'
const { diasHabilesEntre } = require('../utils/diasHabiles')

// Plazo del alquiler de contenedores, en DÍAS HÁBILES: cuánto se le da al cliente
// antes de que el contenedor se marque "Para retirar". Lo determina si el cliente
// tiene cuenta corriente habilitada (no la forma de pago elegida en este alquiler).
// Con cuenta corriente se puede elegir entre PLAZO_ESTANDAR (4) o PLAZO_CUENTA_CORRIENTE
// (10) — ver PLAZOS_CUENTA_CORRIENTE_OPCIONES; sin ella, siempre PLAZO_ESTANDAR.
const PLAZO_CUENTA_CORRIENTE = 10
const PLAZO_ESTANDAR         = 4
const PLAZOS_CUENTA_CORRIENTE_OPCIONES = [PLAZO_ESTANDAR, PLAZO_CUENTA_CORRIENTE]

function plazoPorCuentaCorriente(tieneCuentaCorriente) {
  return tieneCuentaCorriente ? PLAZO_CUENTA_CORRIENTE : PLAZO_ESTANDAR
}

// Plazo con el que se guarda un alquiler nuevo, según las reglas del alta.
// Devuelve { plazo } (null = sin fecha de fin) o { error }.
//  - Sin fecha de fin, o histórico sin fecha de fin → null.
//  - Por defecto, el plazo que le corresponde al cliente (cuenta corriente o estándar).
//  - Histórico o fecha de fin editada a mano → los días hábiles entre inicio y fin
//    (el plazo se guarda en DÍAS HÁBILES, ver sumar_dias_habiles: no los corridos).
//  - Sin cuenta corriente (y no histórico) el plazo es SIEMPRE el estándar: pase lo que
//    pase en el formulario nunca se guarda uno mayor. En carga histórica no rige: ahí se
//    registra la duración real de un alquiler que ya terminó.
function calcularPlazoAlquiler({ fechaInicio, fechaFin, sinFechaFin = false, esHistorico = false, fechaFinManual = false, tieneCC = false }) {
  const fechaFinReal = sinFechaFin ? null : (fechaFin || null)
  let plazo = (sinFechaFin || (esHistorico && !fechaFinReal)) ? null : plazoPorCuentaCorriente(tieneCC)
  if (!sinFechaFin && (esHistorico || fechaFinManual) && fechaInicio && fechaFinReal) {
    plazo = diasHabilesEntre(fechaInicio, fechaFinReal)
    if (plazo < 0) return { error: 'La fecha de fin no puede ser anterior a la de inicio.' }
  }
  if (!tieneCC && !esHistorico && plazo != null) plazo = PLAZO_ESTANDAR
  return { plazo }
}

module.exports = { PLAZO_CUENTA_CORRIENTE, PLAZO_ESTANDAR, PLAZOS_CUENTA_CORRIENTE_OPCIONES, plazoPorCuentaCorriente, calcularPlazoAlquiler }
