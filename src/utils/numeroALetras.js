'use strict'
// Importe en letras para los recibos: 150500.5 → "Pesos ciento cincuenta mil quinientos con 50/100".
// Cubre hasta 999.999.999 (de sobra para un sueldo); más allá devuelve solo el número.

const UNIDADES = ['cero', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve', 'diez',
  'once', 'doce', 'trece', 'catorce', 'quince', 'dieciséis', 'diecisiete', 'dieciocho', 'diecinueve', 'veinte',
  'veintiuno', 'veintidós', 'veintitrés', 'veinticuatro', 'veinticinco', 'veintiséis', 'veintisiete', 'veintiocho', 'veintinueve']
const DECENAS = ['', '', '', 'treinta', 'cuarenta', 'cincuenta', 'sesenta', 'setenta', 'ochenta', 'noventa']
const CENTENAS = ['', 'ciento', 'doscientos', 'trescientos', 'cuatrocientos', 'quinientos', 'seiscientos', 'setecientos', 'ochocientos', 'novecientos']

// 1..999
function menorAMil(n) {
  if (n === 100) return 'cien'
  const partes = []
  const c = Math.floor(n / 100)
  const r = n % 100
  if (c) partes.push(CENTENAS[c])
  if (r) {
    if (r < 30) partes.push(UNIDADES[r])
    else {
      const d = Math.floor(r / 10)
      const u = r % 10
      partes.push(u ? `${DECENAS[d]} y ${UNIDADES[u]}` : DECENAS[d])
    }
  }
  return partes.join(' ')
}

// "uno" → "un" delante de mil / millones ("veintiuno" → "veintiún")
const apocopar = (txt) => txt.replace(/veintiuno$/, 'veintiún').replace(/uno$/, 'un')

function enteroALetras(n) {
  if (n === 0) return 'cero'
  const millones = Math.floor(n / 1e6)
  const miles = Math.floor((n % 1e6) / 1000)
  const resto = n % 1000
  const partes = []
  if (millones) partes.push(millones === 1 ? 'un millón' : `${apocopar(menorAMil(millones))} millones`)
  if (miles) partes.push(miles === 1 ? 'mil' : `${apocopar(menorAMil(miles))} mil`)
  if (resto) partes.push(menorAMil(resto))
  return partes.join(' ')
}

function importeEnLetras(monto) {
  const total = Math.round((Number(monto) || 0) * 100)
  const enteros = Math.floor(total / 100)
  const centavos = total % 100
  if (enteros > 999999999) return `Pesos ${enteros} con ${String(centavos).padStart(2, '0')}/100`
  const letras = enteroALetras(enteros)
  return `Pesos ${letras} con ${String(centavos).padStart(2, '0')}/100`
}

module.exports = { importeEnLetras, enteroALetras }
