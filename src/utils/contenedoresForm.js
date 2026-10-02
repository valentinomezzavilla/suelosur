'use strict'

// Lectura de los formularios de alquileres con varios contenedores.
//
// Las claves llevan una letra adelante a propósito ("c3", "op12"): con claves numéricas
// el parser del formulario (qs) arma un array, compacta los huecos y se pierde a qué
// contenedor u OP correspondía cada valor.

// Selección del alta (Nuevo alquiler):
//  - ids_contenedor[]  → contenedores elegidos (string si es uno, array si son varios)
//  - precio_c[c<ID>]   → precio propio de ese contenedor (vacío = el precio general)
//  - fin_c[c<ID>]      → fecha de fin propia (vacío = la fecha de fin general)
function leerContenedoresDelForm(body = {}) {
  const crudo = body.ids_contenedor
  const lista = Array.isArray(crudo) ? crudo : (crudo == null ? [] : [crudo])
  const ids = lista.map(v => String(v).trim()).filter(Boolean)
  if (new Set(ids).size !== ids.length) return { error: 'Elegiste el mismo contenedor más de una vez.' }
  const precios = (body.precio_c && typeof body.precio_c === 'object') ? body.precio_c : {}
  const fines = (body.fin_c && typeof body.fin_c === 'object') ? body.fin_c : {}
  return {
    contenedores: ids.map(id => ({
      id_contenedor: id,
      precio: String(precios['c' + id] ?? '').trim(),
      fin: String(fines['c' + id] ?? '').trim(),
    })),
  }
}

// Montos de cierre por OP (precio_final[op<ID>]) → { <ID>: monto }. Un monto suelto
// (string) o vacío se devuelve tal cual.
function leerMontosPorOp(valor) {
  if (!valor || typeof valor !== 'object') return valor
  const montos = {}
  for (const [clave, monto] of Object.entries(valor)) montos[String(clave).replace(/^op/, '')] = monto
  return montos
}

module.exports = { leerContenedoresDelForm, leerMontosPorOp }
