'use strict'
const { query } = require('../config/db')

// Operación (no anulada) que ya usa ese número de remito. La numeración es una sola
// secuencia compartida por todos los tipos de operación (ventas y alquileres), porque
// corresponde al talonario físico único del negocio.
async function opConRemito(nro) {
  return (await query(
    `SELECT nro_op FROM op_encabezado WHERE nro_remito = ? AND estado <> 'anulado' LIMIT 1`, [nro])).rows[0]
}

// Remito cargado a mano al crear una operación (el del talonario). Vacío = se asigna
// el siguiente de la secuencia. Devuelve { nro } (nro null = auto) o { error }.
// Un mismo número de remito puede repetirse a propósito entre operaciones (un solo
// papel puede cubrir varias ventas/alquileres cargados por separado): no se bloquea
// acá, solo se avisa en vivo en el formulario (ver remitoCheck.js) para detectar un
// typo. Solo se valida el formato.
async function leerRemito(valor) {
  const txt = String(valor ?? '').trim()
  if (!txt) return { nro: null }
  if (!/^\d{1,8}$/.test(txt) || Number(txt) < 1) return { error: 'El remito tiene que ser un número (hasta 8 dígitos).' }
  return { nro: Number(txt) }
}

module.exports = { leerRemito, opConRemito }
