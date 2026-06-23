'use strict'

// Resuelve un período a { desde, hasta } (YYYY-MM-DD). Default: mes en curso.
// preset: 'hoy' | 'semana' | 'mes' | 'rango'. También acepta `mes` (YYYY-MM) o desde/hasta.
function isoLocal(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function resolverPeriodo({ preset, desde, hasta, mes } = {}) {
  const hoy = new Date()

  if (preset === 'rango' && (desde || hasta)) {
    return { desde: desde || null, hasta: hasta || null, preset: 'rango', mes: null }
  }

  if (mes && /^\d{4}-\d{2}$/.test(mes)) {
    const [y, m] = mes.split('-').map(Number)
    const last = new Date(y, m, 0).getDate()
    return { desde: `${mes}-01`, hasta: `${mes}-${String(last).padStart(2, '0')}`, preset: 'mes', mes }
  }

  if (preset === 'hoy') {
    const d = isoLocal(hoy)
    return { desde: d, hasta: d, preset: 'hoy', mes: null }
  }

  if (preset === 'semana') {
    const dow = (hoy.getDay() + 6) % 7           // lunes = 0
    const lunes = new Date(hoy); lunes.setDate(hoy.getDate() - dow)
    const dom = new Date(lunes); dom.setDate(lunes.getDate() + 6)
    return { desde: isoLocal(lunes), hasta: isoLocal(dom), preset: 'semana', mes: null }
  }

  // Default: mes en curso
  const y = hoy.getFullYear()
  const mm = String(hoy.getMonth() + 1).padStart(2, '0')
  const last = new Date(y, hoy.getMonth() + 1, 0).getDate()
  return { desde: `${y}-${mm}-01`, hasta: `${y}-${mm}-${String(last).padStart(2, '0')}`, preset: 'mes', mes: `${y}-${mm}` }
}

// Etiqueta legible del período (para mostrar en métricas)
function etiquetaPeriodo(p) {
  const meses = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre']
  if (p.preset === 'hoy') return 'Hoy'
  if (p.preset === 'semana') return 'Esta semana'
  if (p.preset === 'mes' && p.mes) { const [y, m] = p.mes.split('-').map(Number); return `${meses[m - 1]} ${y}` }
  if (p.preset === 'rango') {
    const f = (s) => s ? s.split('-').reverse().join('/') : '—'
    return `${f(p.desde)} – ${f(p.hasta)}`
  }
  return 'Período'
}

module.exports = { resolverPeriodo, etiquetaPeriodo }
