'use strict'
// ═══════════════════════════════════════════════════════════════════
// Fecha de pago: el día en que el cliente pagó (o en que se pagó una compra), que puede
// ser anterior al día en que se carga en el sistema ("lo pagaron el viernes y lo cargo
// hoy"). El día de carga queda guardado aparte (created_at / registrado_en).
//
// Reglas, iguales en todos los formularios:
//  · Vacía → hoy.
//  · No puede ser futura (un pago todavía no hecho no se registra).
//  · Formato del <input type="date">: AAAA-MM-DD.
// ═══════════════════════════════════════════════════════════════════
const { hoyISO } = require('./fecha')

const ISO = /^\d{4}-\d{2}-\d{2}$/

function esFechaValida(s) {
  if (!ISO.test(s)) return false
  const d = new Date(s + 'T00:00:00Z')
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}

// valor del formulario → { fecha: 'AAAA-MM-DD', error: null } o { fecha: null, error: 'mensaje' }
function leerFechaPago(valor, { hoy = hoyISO(), etiqueta = 'La fecha de pago' } = {}) {
  const s = String(valor ?? '').trim().slice(0, 10)
  if (!s) return { fecha: hoy, error: null }
  if (!esFechaValida(s)) return { fecha: null, error: `${etiqueta} no es válida.` }
  if (s > hoy) return { fecha: null, error: `${etiqueta} no puede ser posterior a hoy.` }
  return { fecha: s, error: null }
}

// Fecha y hora a guardar: hoy → null (la base pone la hora real con ahora_local());
// un día anterior → ese día a las 12:00, como el resto de las cargas con fecha pasada.
function fechaHoraDePago(fecha, hoy = hoyISO()) {
  if (!fecha || fecha >= hoy) return null
  return `${fecha} 12:00:00`
}

module.exports = { leerFechaPago, fechaHoraDePago, esFechaValida }
