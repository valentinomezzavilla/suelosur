'use strict'

// Suma N días hábiles (lunes a sábado, sin feriados) a una fecha 'YYYY-MM-DD'. El día
// de inicio CUENTA como día 1 del plazo (así lo pide el negocio: un alquiler de 4 días
// que arranca jueves cubre jueves-viernes-sábado-lunes, no jueves + 4 días hábiles más),
// así que para llegar al día N hay que avanzar N-1 días hábiles desde el inicio.
// Espejo en JS de la función SQL `sumar_dias_habiles` (src/config/db.js) — mismos
// resultados, para no desalinear lo que se calcula en Node de lo que calcula Postgres.
// dias <= 1 devuelve la fecha de inicio sin cambios; dias null/undefined devuelve null.
function sumarDiasHabiles(fechaISO, dias) {
  if (dias == null) return null
  if (!fechaISO) return null
  const base = String(fechaISO).slice(0, 10)
  const d = new Date(base + 'T00:00:00')
  if (isNaN(d.getTime())) return null
  let restantes = Math.trunc(dias) - 1
  if (restantes <= 0) return base
  while (restantes > 0) {
    d.setDate(d.getDate() + 1)
    const dow = d.getDay() // 0 = domingo
    if (dow !== 0) restantes--
  }
  return d.toISOString().slice(0, 10)
}

// Inverso de sumarDiasHabiles: el plazo (en días, contando el de inicio como día 1) que
// hay entre dos fechas 'YYYY-MM-DD' (sumarDiasHabiles(ini, diasHabilesEntre(ini, fin))
// === fin). Con fin === ini da 1 (un solo día). Con fin < ini devuelve la diferencia en
// días corridos (negativa), como señal de rango inválido para que el llamador la rechace.
function diasHabilesEntre(fechaInicioISO, fechaFinISO) {
  const ini = new Date(String(fechaInicioISO).slice(0, 10) + 'T00:00:00')
  const fin = new Date(String(fechaFinISO).slice(0, 10) + 'T00:00:00')
  if (isNaN(ini.getTime()) || isNaN(fin.getTime())) return null
  if (fin < ini) return Math.round((fin - ini) / 86400000)
  let dias = 0
  const d = new Date(ini.getTime())
  while (d < fin) {
    d.setDate(d.getDate() + 1)
    const dow = d.getDay()
    if (dow !== 0) dias++
  }
  return dias + 1
}

module.exports = { sumarDiasHabiles, diasHabilesEntre }
