'use strict'

// Contenedor vendido como producto: va de a UNO por operación, su unidad es "Días" y
// el precio por día sale del rango en que cae la cantidad de días del alquiler.
//   Rangos: 1–3 → $30.000/día · 4–9 → $28.000/día · 10 en adelante → $25.000/día
//   7 días → 7 × $28.000 = $196.000
// Los rangos son contiguos y arrancan en 1; solo el último puede quedar abierto.

const UNIDAD_CONTENEDOR = 'Días'
const MAX_CONTENEDORES_POR_OP = 1

const aLista = (v) => (v == null ? [] : Array.isArray(v) ? v : [v])

// Arma los rangos a partir de lo que manda el formulario de producto (rango_hasta[] y
// rango_precio[]). El "desde" no se carga: es el "hasta" anterior + 1.
// Devuelve { rangos } o { error }.
function normalizarRangos(hastas, precios) {
  const hs = aLista(hastas)
  const ps = aLista(precios)
  const filas = []
  for (let i = 0; i < Math.max(hs.length, ps.length); i++) {
    const h = String(hs[i] ?? '').trim()
    const p = String(ps[i] ?? '').trim()
    if (!h && !p) continue
    filas.push({ h, p })
  }
  if (!filas.length) return { error: 'Cargá al menos un rango de precio por días.' }

  const rangos = []
  let desde = 1
  for (let i = 0; i < filas.length; i++) {
    const { h, p } = filas[i]
    const ultimo = i === filas.length - 1
    const precio = Number(p)
    if (!p || !Number.isFinite(precio) || precio <= 0) {
      return { error: `El rango ${i + 1} necesita un precio por día mayor a cero.` }
    }
    let hasta = null
    if (h) {
      hasta = Number(h)
      if (!Number.isInteger(hasta) || hasta < desde) {
        return { error: `El rango ${i + 1} arranca en ${desde} día(s): el "hasta" tiene que ser un número entero mayor o igual a ${desde}.` }
      }
    } else if (!ultimo) {
      return { error: `Solo el último rango puede quedar abierto ("en adelante"). Completá el "hasta" del rango ${i + 1}.` }
    }
    rangos.push({ dias_desde: desde, dias_hasta: hasta, precio_dia: precio })
    if (hasta == null) break
    desde = hasta + 1
  }
  return { rangos }
}

// Rango que corresponde a esa cantidad de días (o null si no hay ninguno).
function rangoParaDias(rangos, dias) {
  const n = Number(dias)
  if (!Number.isInteger(n) || n < 1) return null
  return (rangos || []).find(r => n >= Number(r.dias_desde) && (r.dias_hasta == null || n <= Number(r.dias_hasta))) || null
}

// Precio del renglón de un contenedor. Devuelve { dias, precio_dia, subtotal } o { error }.
function cotizarContenedor(rangos, dias) {
  const n = Number(dias)
  if (!Number.isInteger(n) || n < 1) return { error: 'Indicá la cantidad de días del contenedor (número entero, mínimo 1).' }
  const rango = rangoParaDias(rangos, n)
  if (!rango) {
    const max = Math.max(...(rangos || []).map(r => Number(r.dias_hasta) || 0), 0)
    return { error: max ? `El contenedor tiene precio hasta ${max} días.` : 'El contenedor no tiene rangos de precio cargados.' }
  }
  const precio_dia = Number(rango.precio_dia) || 0
  return { dias: n, precio_dia, subtotal: n * precio_dia }
}

// Para los SELECT sobre op_detalle_material d JOIN productos p: el renglón de un
// contenedor se muestra como "Contenedor (7 días)" y su unidad es el contenedor.
const SQL_DESCRIPCION_DETALLE = `(p.nombre || CASE WHEN d.dias IS NOT NULL THEN ' (' || d.dias || ' días)' ELSE '' END)`
const SQL_UNIDAD_DETALLE = `(CASE WHEN d.dias IS NOT NULL THEN 'unid.' ELSE p.unidad_medida END)`

module.exports = {
  UNIDAD_CONTENEDOR, MAX_CONTENEDORES_POR_OP,
  normalizarRangos, rangoParaDias, cotizarContenedor,
  SQL_DESCRIPCION_DETALLE, SQL_UNIDAD_DETALLE,
}
