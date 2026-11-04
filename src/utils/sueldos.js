'use strict'
// Sueldos del mes por empleado (Flota de Personal). Lógica pura, sin base.
//
// Qué cuenta como "sueldo pagado" del mes: sueldo, anticipo y liquidación, menos los
// descuentos. Viáticos, horas extra y bonificaciones son "otros pagos": se muestran aparte
// y no completan el sueldo. Un pago es del mes de su período (AAAA-MM); si no tiene
// período cargado, del mes de su fecha.

const DEL_SUELDO = new Set(['sueldo', 'anticipo', 'liquidacion'])
const OTROS = new Set(['viatico', 'horas_extra', 'bonificacion'])
const CENTAVO = 0.01
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100

const ESTADOS = {
  pagado:     { etiqueta: 'Pagado',          clase: 'badge-activo' },
  parcial:    { etiqueta: 'Pagado en parte', clase: 'badge-en-transito' },
  sin_pagar:  { etiqueta: 'Sin pagar',       clase: 'badge-alerta' },
  sin_sueldo: { etiqueta: 'Sin sueldo en la ficha', clase: 'badge-pendiente' },
}

// filas: [{ tipo, total }] de un empleado en el mes → { sueldo, otros }
function totalesDelMes(filas) {
  let sueldo = 0, otros = 0
  for (const f of filas || []) {
    const t = Number(f.total) || 0
    if (DEL_SUELDO.has(f.tipo)) sueldo += t
    else if (f.tipo === 'descuento') sueldo -= t
    else if (OTROS.has(f.tipo)) otros += t
  }
  return { sueldo: r2(sueldo), otros: r2(otros) }
}

// establecido: sueldo de la ficha; pagado: sueldo pagado del mes → clave de ESTADOS
function estadoSueldo(establecido, pagado) {
  const e = Number(establecido) || 0
  const p = Number(pagado) || 0
  if (e <= 0) return p > CENTAVO ? 'pagado' : 'sin_sueldo'
  if (p >= e - CENTAVO) return 'pagado'
  return p > CENTAVO ? 'parcial' : 'sin_pagar'
}

function mesValido(mes) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(mes || '')) ? String(mes) : null
}

module.exports = { ESTADOS, totalesDelMes, estadoSueldo, mesValido }
