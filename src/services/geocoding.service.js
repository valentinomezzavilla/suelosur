'use strict'

// Geocodificación de direcciones con Nominatim (OpenStreetMap), del lado del servidor.
// Se usa UNA vez al crear/editar un alquiler (y en el backfill): las coordenadas quedan
// guardadas en la base y el mapa nunca vuelve a consultar Nominatim.
//
// Política de uso de Nominatim: máximo 1 request por segundo y un User-Agent que
// identifique la aplicación. Todas las llamadas del proceso pasan por una cola que
// las espacia; si se configura NOMINATIM_EMAIL se manda también como contacto.

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search'
const USER_AGENT    = process.env.NOMINATIM_USER_AGENT || 'SuelosurGestion/1.0 (sistema interno de logistica de contenedores)'
const INTERVALO_MS  = 1100   // un poco más de 1 s entre requests, por margen
const TIMEOUT_MS    = 8000

// La empresa opera en Córdoba capital y alrededores (mismo recuadro que MapService):
// [minLon, maxLat, maxLon, minLat] → viewbox de Nominatim.
const CORDOBA_VIEWBOX = '-64.45,-31.20,-63.95,-31.60'

// Si los resultados candidatos quedan más lejos que esto entre sí, la dirección es
// ambigua (ej.: la misma calle y altura en dos barrios distintos).
const DISTANCIA_AMBIGUA_M = 1500

let cola = Promise.resolve()
let ultimaLlamada = 0

// Encola fn para que entre dos llamadas a Nominatim pase al menos INTERVALO_MS.
function enCola(fn) {
  const tarea = cola.then(async () => {
    const espera = ultimaLlamada + INTERVALO_MS - Date.now()
    if (espera > 0) await new Promise(r => setTimeout(r, espera))
    try { return await fn() } finally { ultimaLlamada = Date.now() }
  })
  cola = tarea.catch(() => {})
  return tarea
}

function distanciaMetros(a, b) {
  const R = 6371000
  const rad = x => x * Math.PI / 180
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

// Texto de la consulta: calle, número, localidad y provincia. No hay campos de
// localidad/provincia en los alquileres: se asume Córdoba capital.
function armarConsulta({ calle, numero }) {
  const dir = [String(calle || '').trim(), String(numero || '').trim()].filter(Boolean).join(' ')
  if (!dir) return ''
  return `${dir}, Córdoba, Córdoba, Argentina`
}

async function buscar(q) {
  const params = new URLSearchParams({
    q, format: 'jsonv2', limit: '5', addressdetails: '1',
    countrycodes: 'ar', viewbox: CORDOBA_VIEWBOX, bounded: '1',
  })
  if (process.env.NOMINATIM_EMAIL) params.set('email', process.env.NOMINATIM_EMAIL)
  const resp = await fetch(`${NOMINATIM_URL}?${params}`, {
    headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'es' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!resp.ok) throw new Error(`Nominatim respondió ${resp.status}`)
  return resp.json()
}

// Devuelve { estado, lat, lng, display }:
//   'ok'            → coordenadas confiables
//   'sin_direccion' → no hay calle para buscar (solo obra)
//   'sin_resultado' → Nominatim no encontró nada en Córdoba
//   'ambigua'       → varios lugares posibles y alejados entre sí
//   'error'         → falla de red / timeout / respuesta inválida
// Nunca tira excepción: quien llama decide qué hacer con el estado.
async function geocodificarDireccion({ calle, numero }) {
  const q = armarConsulta({ calle, numero })
  if (!q) return { estado: 'sin_direccion', lat: null, lng: null }
  try {
    const data = await enCola(() => buscar(q))
    const candidatos = (Array.isArray(data) ? data : [])
      .map(d => ({ lat: parseFloat(d.lat), lng: parseFloat(d.lon), display: d.display_name, importance: d.importance || 0 }))
      .filter(d => Number.isFinite(d.lat) && Number.isFinite(d.lng))
    if (!candidatos.length) return { estado: 'sin_resultado', lat: null, lng: null }

    // Ambigua: hay otro candidato casi tan relevante como el primero y lejos de él.
    const [mejor, ...resto] = candidatos
    const rival = resto.find(c => c.importance >= mejor.importance * 0.9
      && distanciaMetros(mejor, c) > DISTANCIA_AMBIGUA_M)
    if (rival) return { estado: 'ambigua', lat: null, lng: null, display: mejor.display }

    return { estado: 'ok', lat: mejor.lat, lng: mejor.lng, display: mejor.display }
  } catch (e) {
    console.error('Geocodificación falló:', e.message)
    return { estado: 'error', lat: null, lng: null }
  }
}

module.exports = { geocodificarDireccion, armarConsulta }
