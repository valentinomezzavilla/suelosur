'use strict'

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

module.exports = { PLAZO_CUENTA_CORRIENTE, PLAZO_ESTANDAR, PLAZOS_CUENTA_CORRIENTE_OPCIONES, plazoPorCuentaCorriente }
