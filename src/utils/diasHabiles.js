'use strict'

// Suma N días hábiles (lunes a viernes, sin feriados) a una fecha 'YYYY-MM-DD'.
// Espejo en JS de la función SQL `sumar_dias_habiles` (src/config/db.js) — mismos
// resultados, para no desalinear lo que se calcula en Node de lo que calcula Postgres.
// dias <= 0 devuelve la fecha de inicio sin cambios; dias null/undefined devuelve null.
function sumarDiasHabiles(fechaISO, dias) {
  if (dias == null) return null
  if (!fechaISO) return null
  const d = new Date(String(fechaISO).slice(0, 10) + 'T00:00:00')
  if (isNaN(d.getTime())) return null
  let restantes = Math.trunc(dias)
  if (restantes <= 0) return fechaISO.slice(0, 10)
  while (restantes > 0) {
    d.setDate(d.getDate() + 1)
    const dow = d.getDay() // 0 = domingo, 6 = sábado
    if (dow !== 0 && dow !== 6) restantes--
  }
  return d.toISOString().slice(0, 10)
}

// Inverso de sumarDiasHabiles: cuántos días hábiles hay ESTRICTAMENTE entre dos fechas
// 'YYYY-MM-DD' (sumarDiasHabiles(ini, diasHabilesEntre(ini, fin)) === fin). Con fin <=
// ini devuelve la diferencia en días corridos (negativa o 0), igual que un resta simple.
function diasHabilesEntre(fechaInicioISO, fechaFinISO) {
  const ini = new Date(String(fechaInicioISO).slice(0, 10) + 'T00:00:00')
  const fin = new Date(String(fechaFinISO).slice(0, 10) + 'T00:00:00')
  if (isNaN(ini.getTime()) || isNaN(fin.getTime())) return null
  if (fin <= ini) return Math.round((fin - ini) / 86400000)
  let dias = 0
  const d = new Date(ini.getTime())
  while (d < fin) {
    d.setDate(d.getDate() + 1)
    const dow = d.getDay()
    if (dow !== 0 && dow !== 6) dias++
  }
  return dias
}

module.exports = { sumarDiasHabiles, diasHabilesEntre }
