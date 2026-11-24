'use strict'

// Parámetros de una URL (sin el "?") a partir de un objeto de filtros. Omite los vacíos
// ('', null, undefined) y las listas vacías; una lista repite el parámetro, una vez por
// valor (obra=a&obra=b), que es como lo leen los filtros de varias obras.
function consulta(obj = {}) {
  const p = new URLSearchParams()
  for (const [clave, valor] of Object.entries(obj || {})) {
    for (const v of [].concat(valor)) {
      if (v === '' || v == null) continue
      p.append(clave, v)
    }
  }
  return p.toString()
}

module.exports = { consulta }
