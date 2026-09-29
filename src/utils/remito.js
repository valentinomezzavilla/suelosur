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
async function leerRemito(valor) {
  const txt = String(valor ?? '').trim()
  if (!txt) return { nro: null }
  if (!/^\d{1,8}$/.test(txt) || Number(txt) < 1) return { error: 'El remito tiene que ser un número (hasta 8 dígitos).' }
  const nro = Number(txt)
  const dup = await opConRemito(nro)
  if (dup) return { error: `El remito ${nro} ya está cargado en OP-${String(dup.nro_op).padStart(4, '0')}.` }
  return { nro }
}

module.exports = { leerRemito, opConRemito }
