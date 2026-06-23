'use strict'

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

module.exports = { fmtFecha, fmtFechaHora }
