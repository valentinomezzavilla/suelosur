'use strict'

// Texto del destino de una entrega. En las operaciones se carga la dirección (calle y
// número), la obra, o las dos — así que ningún documento puede depender solo de la calle.
// `domicilio` es la dirección ya armada, para las tablas que la guardan en un solo campo.
function textoDestino({ calle, numero, domicilio, obra } = {}) {
  const dir = String(domicilio || '').trim() || [calle, numero].filter(Boolean).join(' ').trim()
  const o = String(obra || '').trim()
  if (dir && o) return `${dir} · Obra: ${o}`
  if (dir) return dir
  if (o) return `Obra: ${o}`
  return ''
}

// Para direcciones sin altura (esquinas, "X y Y") el formulario obligaba a completar el
// número y se repetía la calle ahí. Si el número es igual a la calle, no es un número.
function numeroSinRepetirCalle(calle, numero) {
  const n = String(numero || '').trim()
  if (n && n.toLowerCase() === String(calle || '').trim().toLowerCase()) return ''
  return n
}

module.exports = { textoDestino, numeroSinRepetirCalle }
