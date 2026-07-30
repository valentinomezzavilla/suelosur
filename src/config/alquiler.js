'use strict'

// Plazo del alquiler de contenedores: días que se suman a la fecha de inicio para
// obtener la fecha de fin. Lo determina si el cliente tiene cuenta corriente
// habilitada (no la forma de pago elegida en este alquiler).
const PLAZO_CUENTA_CORRIENTE = 15
const PLAZO_ESTANDAR         = 4

function plazoPorCuentaCorriente(tieneCuentaCorriente) {
  return tieneCuentaCorriente ? PLAZO_CUENTA_CORRIENTE : PLAZO_ESTANDAR
}

module.exports = { PLAZO_CUENTA_CORRIENTE, PLAZO_ESTANDAR, plazoPorCuentaCorriente }
