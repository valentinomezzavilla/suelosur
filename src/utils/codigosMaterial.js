'use strict'
// ═══════════════════════════════════════════════════════════════════
// codigosMaterial.js — Mapeo material → código corto para el libro de ventas.
//
// EDITÁ ESTA TABLA con tus materiales/códigos. La clave es el nombre del
// material en minúsculas y sin acentos (ej. 'arena gruesa'). Si el material
// no está exacto, se intenta por coincidencia parcial (ej. 'triturado oscuro
// 1-2 + flete' → 'triturado' → 'T'); si aún así no matchea, se derivan las
// iniciales de las 2 primeras palabras.
// ═══════════════════════════════════════════════════════════════════

const CODIGOS = {
  'arena gruesa':     'AG',
  'arena fina':       'AF',
  'grancilla 1-3':    'G1',
  'grancilla':        'G1',
  'contenedor':       'CN',
  '0-20':             'CV',
  'triturado':        'T',
  'piedra partida':   'PP',
  'piedra bola':      'PB',
  'canto rodado':     'CR',
  'tosca':            'TO',
  'maquinaria':       'MQ',
  // Servicios / especiales que aparecen en la planilla
  'viaje retiro material con pala': 'VR',
  'saldo anterior':   'SR',
}

function normalizar(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // sacar acentos
    .trim()
}

// Devuelve el código corto para un nombre de material.
function codigoMaterial(nombre) {
  const n = normalizar(nombre)
  if (!n) return '—'
  if (CODIGOS[n]) return CODIGOS[n]
  // Coincidencia parcial (el nombre contiene alguna clave conocida)
  for (const [k, v] of Object.entries(CODIGOS)) {
    if (k.length >= 3 && n.includes(k)) return v
  }
  // Fallback: iniciales de las 2 primeras palabras
  const palabras = n.split(/\s+/).filter(Boolean)
  return palabras.slice(0, 2).map(w => w[0]).join('').toUpperCase() || '—'
}

module.exports = { codigoMaterial, CODIGOS }
