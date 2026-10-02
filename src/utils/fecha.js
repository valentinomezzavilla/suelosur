'use strict'

// Zona horaria del negocio. Todas las fechas y horas del sistema se guardan y muestran
// en hora de Argentina (la base y el servidor corren en UTC: ver src/config/db.js y server.js).
const ZONA_HORARIA = 'America/Argentina/Cordoba'

// Partes de la fecha/hora actual en Argentina, sin depender de la zona del proceso.
function partesAhora() {
  const p = {}
  for (const { type, value } of new Intl.DateTimeFormat('en-CA', {
    timeZone: ZONA_HORARIA, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date())) p[type] = value
  return p
}

// 'YYYY-MM-DD' de hoy en Argentina. Reemplaza a new Date().toISOString().slice(0, 10),
// que da la fecha UTC (entre las 21 y las 24 hs ya es "mañana").
function hoyISO() {
  const p = partesAhora()
  return `${p.year}-${p.month}-${p.day}`
}

// 'YYYY-MM-DD HH:MM:SS' de ahora en Argentina (mismo formato que ahora_local() en SQL).
function ahoraLocal() {
  const p = partesAhora()
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`
}

// Formato único del sistema: DD/MM/AAAA.
// Acepta ISO (YYYY-MM-DD), datetime (YYYY-MM-DD HH:MM:SS), legacy (DD-MM-YYYY) y Date.
// Usa parseo de string (no new Date) para fechas ISO, evitando corrimientos por zona horaria.
function fmtFecha(value) {
  if (!value) return ''
  const s = String(value).trim()
  const datePart = s.split(/[ T]/)[0]

  let m = datePart.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (m) return `${m[3]}/${m[2]}/${m[1]}`

  m = datePart.match(/^(\d{2})-(\d{2})-(\d{4})$/)   // legacy DD-MM-YYYY
  if (m) return `${m[1]}/${m[2]}/${m[3]}`

  if (/^\d{2}\/\d{2}\/\d{4}$/.test(datePart)) return datePart  // ya DD/MM/YYYY

  const d = new Date(s)
  if (!isNaN(d.getTime())) {
    const p = (n) => String(n).padStart(2, '0')
    return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`
  }
  return s
}

// DD/MM/AAAA HH:MM
function fmtFechaHora(value) {
  if (!value) return ''
  const s = String(value).trim()
  const fecha = fmtFecha(s)
  const t = s.split(/[ T]/)[1]
  return t ? `${fecha} ${t.slice(0, 5)}` : fecha
}

module.exports = { fmtFecha, fmtFechaHora, hoyISO, ahoraLocal, ZONA_HORARIA }
