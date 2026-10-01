'use strict'

// Geocodificación de direcciones con OpenStreetMap, del lado del servidor.
// Se usa UNA vez al crear/editar un alquiler (y en el backfill): las coordenadas quedan
// guardadas en la base y el mapa nunca vuelve a consultar estos servicios.
//
// Las direcciones reales vienen de muchas formas ("San Lorenzo 501", "DOCTA MZ 42 LOTE 24",
// "SAN LORENZO Y OBISPO SALGUERO", "B° LOS ROBLES PUB 2 N° 413"), así que se busca en cascada
// y se guarda qué tan precisa salió la ubicación:
//   'ok'     → la dirección exacta (con altura) o un lugar con nombre
//   'cruce'  → la esquina de dos calles (Overpass)
//   'calle'  → la calle, sin poder ubicar la altura         (aproximada)
//   'barrio' → el centro del barrio / country               (aproximada)
// Si nada funciona: 'sin_resultado' | 'ambigua' | 'sin_direccion' | 'error'.
//
// Política de uso de Nominatim/Overpass: máximo 1 request por segundo y un User-Agent que
// identifique la aplicación. Todas las llamadas del proceso pasan por una cola que las
// espacia; si se configura NOMINATIM_EMAIL se manda también como contacto.

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search'
const OVERPASS_URL  = 'https://overpass-api.de/api/interpreter'
const USER_AGENT    = process.env.NOMINATIM_USER_AGENT || 'SuelosurGestion/1.0 (sistema interno de logistica de contenedores)'
const INTERVALO_MS  = 1100   // un poco más de 1 s entre requests, por margen
const TIMEOUT_MS    = 10000

// La empresa opera en Córdoba capital y alrededores (mismo recuadro que MapService).
const BBOX = { minLat: -31.60, maxLat: -31.20, minLng: -64.45, maxLng: -63.95 }
const VIEWBOX = `${BBOX.minLng},${BBOX.maxLat},${BBOX.maxLng},${BBOX.minLat}`

// Candidatos a más de esta distancia entre sí = lugares distintos (dirección ambigua).
const DISTANCIA_AMBIGUA_M = 1500

// Tipos de resultado de Nominatim que representan un barrio / country / zona.
const TIPOS_BARRIO = new Set(['suburb', 'neighbourhood', 'quarter', 'residential', 'city_district',
  'hamlet', 'village', 'town', 'isolated_dwelling', 'allotments', 'farm'])

// ── Cola: entre dos llamadas a OSM pasa al menos INTERVALO_MS ─────────────────
let cola = Promise.resolve()
let ultimaLlamada = 0
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

const tituloCase = (s) => s.toLowerCase().replace(/(^|\s)(\p{L})/gu, (m, sp, l) => sp + l.toUpperCase())

// ── Análisis del texto de la dirección ────────────────────────────────────────

// Abreviaturas comunes en cómo se cargan las direcciones.
function expandirAbreviaturas(s) {
  return ` ${s} `
    .replace(/\s(AV|AVDA)\.?\s/gi, ' Avenida ')
    .replace(/\s(BV|BLVD|BULEV)\.?\s/gi, ' Bulevar ')
    .replace(/\sGRAL\.?\s/gi, ' General ')
    .replace(/\sCNEL\.?\s/gi, ' Coronel ')
    .replace(/\sPTE\.?\s/gi, ' Presidente ')
    .replace(/\sDR\.?\s/gi, ' Doctor ')
    .replace(/\sSTO\.?\s/gi, ' Santo ')
    .replace(/\s(1ERO|1RO|1ER|1°|1º)\s/gi, ' Primero ')
    .replace(/\sMANANT\.?\s/gi, ' Manantiales ')
    .replace(/\s+/g, ' ')
    .trim()
}

// Palabras que no forman parte del nombre de un barrio.
const RUIDO_BARRIO = /^(MZ|MZA|MANZANA|LOTE|LT|LOTES|CASA|DPTO|DEPTO|PISO|INGRESO|ENTRADA|PORTON|PORTÓN|GUARDIA|PUB|PUBLICA|PÚBLICA|CALLE|N|NRO|NUMERO|NÚMERO|B|BO|BARRIO|COUNTRY|BARRIO PRIVADO|PRIVADO|URBANIZACION|URBANIZACIÓN)$/i
const CARDINALES = /^(SUR|NORTE|ESTE|OESTE|I|II|III|IV)$/i

// Separa el texto cargado en las piezas que sirven para buscar.
function analizarDireccion(calleRaw, numeroRaw) {
  let calle = String(calleRaw || '').trim().replace(/\s+/g, ' ')
  let numero = String(numeroRaw || '').trim()
  // El número repetido como calle ("AUTONEUM AUTONEUM") o pegado al final de la calle
  // ("LOMAS MANANTIALES 141 - 5" + "141 - 5") no es un número aparte.
  if (numero && numero.toLowerCase() === calle.toLowerCase()) numero = ''
  if (numero && calle.toLowerCase().endsWith(numero.toLowerCase())) calle = calle.slice(0, -numero.length).trim()

  // Manzana y lote: barrio cerrado / loteo. Ahí la "calle" es en realidad el barrio.
  const esLote = /\b(MZ|MZA|MANZANA|LOTE|LT)\b|\b[LM]\s?\d+\b/i.test(calle) || /^\d+\s*-\s*\d+$/.test(numero)
  // Barrio explícito: "B° LOS ROBLES PUB 2 N° 413"
  const mBarrio = /\bB(?:°|º|ARRIO|O\.?)\s*([^\d]+?)(?=\s+(?:PUB|PUBLICA|PÚBLICA|CALLE|N°|Nº|MZ|LOTE|\d)|$)/i.exec(calle)

  // Esquina sin altura: "SAN LORENZO Y OBISPO SALGUERO", "COLÓN ESQ. GENERAL PAZ"
  let cruce = null
  if (!numero && !esLote) {
    const partes = calle.split(/\s+(?:Y|E|ESQ\.?|ESQUINA)\s+/i)
    if (partes.length === 2 && partes.every(p => p.trim().length >= 3)) cruce = partes.map(p => expandirAbreviaturas(p.trim()))
  }

  // Altura: solo si es un número de verdad (no "42 - 24" de manzana-lote)
  const alturaMatch = /^\d{1,5}$/.exec(numero.replace(/\s/g, ''))
  const altura = alturaMatch && !esLote ? alturaMatch[0] : ''

  // Nombre de barrio candidato: el texto sin los tokens de manzana, lote, números, etc.
  const textoBarrio = mBarrio ? mBarrio[1] : calle
  const palabras = expandirAbreviaturas(textoBarrio.replace(/[°º#.,\-/]/g, ' '))
    .split(/\s+/)
    .filter(w => w && !/\d/.test(w) && !RUIDO_BARRIO.test(w) && !/^[LM]$/i.test(w))
  const barrio = palabras.length ? tituloCase(palabras.join(' ')) : ''

  return {
    calle: expandirAbreviaturas(calle.replace(/\bN[°º]\s*/gi, '')),
    altura, esLote, cruce, barrio, barrioExplicito: !!mBarrio,
  }
}

// Variantes del nombre de un barrio para probar en orden ("Lomas Manantiales" →
// "Lomas de Manantiales" → "Manantiales"; "La Santina Sur" → "La Santina"; "Docta" → "La Docta").
// `amplio`: el texto seguro es un barrio (manzana/lote o "B°"), así que vale probar solo la
// última palabra ("Manantiales"); con un nombre de calle eso caería en cualquier lado.
function variantesBarrio(barrio, amplio = true) {
  const out = []
  const add = (s) => { s = s.trim(); if (s && !out.includes(s)) out.push(s) }
  const w = barrio.split(' ')
  add(barrio)
  const sinCardinal = w.filter((x, i) => !(i > 0 && CARDINALES.test(x)))
  add(sinCardinal.join(' '))
  if (!amplio) return out
  const articulo = /^(de|del|la|las|los|el|san|santa|santo)$/i
  if (sinCardinal.length >= 2 && !articulo.test(sinCardinal[0]) && !articulo.test(sinCardinal[1])) {
    add([sinCardinal[0], 'de', ...sinCardinal.slice(1)].join(' '))
  }
  if (sinCardinal.length === 1) add('La ' + sinCardinal[0])
  const ultima = sinCardinal[sinCardinal.length - 1]
  if (sinCardinal.length >= 2 && ultima.length >= 6 && !articulo.test(sinCardinal[sinCardinal.length - 2])) add(ultima)
  return out.slice(0, 4)
}

// ── Consultas a OSM ───────────────────────────────────────────────────────────

async function nominatim(q) {
  const params = new URLSearchParams({
    q, format: 'jsonv2', limit: '5', addressdetails: '1',
    countrycodes: 'ar', viewbox: VIEWBOX, bounded: '1',
  })
  if (process.env.NOMINATIM_EMAIL) params.set('email', process.env.NOMINATIM_EMAIL)
  const data = await enCola(async () => {
    const resp = await fetch(`${NOMINATIM_URL}?${params}`, {
      headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'es' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!resp.ok) throw new Error(`Nominatim respondió ${resp.status}`)
    return resp.json()
  })
  return (Array.isArray(data) ? data : [])
    .map(d => ({
      lat: parseFloat(d.lat), lng: parseFloat(d.lon), display: d.display_name,
      importance: d.importance || 0, categoria: d.category, tipo: d.addresstype || d.type,
      address: d.address || {},
    }))
    .filter(d => Number.isFinite(d.lat) && Number.isFinite(d.lng))
}

// Elige el candidato si no hay otro igual de relevante y lejos (= ambiguo). Ante la
// duda se queda con el que está en Córdoba capital, que es donde opera la empresa.
function elegir(candidatos) {
  if (!candidatos.length) return null
  const ambiguo = (lista) => {
    const [mejor, ...resto] = lista
    return resto.some(c => c.importance >= mejor.importance * 0.9 && distanciaMetros(mejor, c) > DISTANCIA_AMBIGUA_M)
  }
  if (!ambiguo(candidatos)) return { elegido: candidatos[0] }
  const enCapital = candidatos.filter(c => (c.address.city || c.address.town) === 'Córdoba')
  if (enCapital.length && !ambiguo(enCapital)) return { elegido: enCapital[0] }
  return { ambigua: true, elegido: candidatos[0] }
}

const nombreCalle = (c) => c.address.road || c.display.split(',')[0]

// Dirección con altura (o lugar con nombre). Exacta si OSM conoce la altura; si solo
// encuentra la calle, queda como aproximada.
async function buscarDireccion(calle, altura) {
  const q = `${[calle, altura].filter(Boolean).join(' ')}, Córdoba, Argentina`
  const r = elegir(await nominatim(q))
  if (!r) return null
  if (r.ambigua) return { estado: 'ambigua', lat: null, lng: null, detalle: r.elegido.display }
  const c = r.elegido
  if (c.address.house_number || (c.categoria !== 'highway' && !TIPOS_BARRIO.has(c.tipo))) {
    return { estado: 'ok', lat: c.lat, lng: c.lng, detalle: c.display }
  }
  if (c.categoria === 'highway') {
    return { estado: 'calle', lat: c.lat, lng: c.lng, detalle: `Calle ${nombreCalle(c)} (sin la altura ${altura || ''})`.replace(' )', ')') }
  }
  return { estado: 'barrio', lat: c.lat, lng: c.lng, detalle: `Zona ${c.display.split(',')[0]}` }
}

// Centro del barrio / country. Solo acepta resultados que sean zonas (no un edificio
// o comercio que se llame igual).
async function buscarBarrio(barrio, amplio) {
  for (const nombre of variantesBarrio(barrio, amplio)) {
    const candidatos = (await nominatim(`${nombre}, Córdoba, Argentina`))
      .filter(c => TIPOS_BARRIO.has(c.tipo) || c.categoria === 'landuse' || c.categoria === 'place')
    const r = elegir(candidatos)
    if (r && !r.ambigua) {
      return { estado: 'barrio', lat: r.elegido.lat, lng: r.elegido.lng, detalle: `Barrio ${r.elegido.display.split(',')[0]} (centro aproximado)` }
    }
  }
  return null
}

// Regex de Overpass que ignora mayúsculas y tildes ("OBISPO SALGUERO" ↔ "Obispo Salguero").
function regexNombre(nombre) {
  const sinTildes = nombre.normalize('NFD').replace(/[̀-ͯ]/g, '')
  const esc = sinTildes.replace(/[.*+?^${}()|[\]\\"]/g, '\\$&')
  return esc.replace(/[aA]/g, '[aá]').replace(/[eE]/g, '[eé]').replace(/[iI]/g, '[ií]')
    .replace(/[oO]/g, '[oó]').replace(/[uU]/g, '[uúü]').replace(/[nN]/g, '[nñ]')
}

// Esquina de dos calles: nodo compartido por calles con esos nombres (Overpass).
async function buscarCruce([calle1, calle2]) {
  const bbox = `${BBOX.minLat},${BBOX.minLng},${BBOX.maxLat},${BBOX.maxLng}`
  const ql = `[out:json][timeout:20];
    way["highway"]["name"~"${regexNombre(calle1)}",i](${bbox})->.a;
    way["highway"]["name"~"${regexNombre(calle2)}",i](${bbox})->.b;
    node(w.a)(w.b);
    out;`
  const data = await enCola(async () => {
    const resp = await fetch(OVERPASS_URL, {
      method: 'POST',
      headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ data: ql }),
      signal: AbortSignal.timeout(25000),
    })
    if (!resp.ok) throw new Error(`Overpass respondió ${resp.status}`)
    return resp.json()
  })
  const nodos = (data.elements || []).map(n => ({ lat: n.lat, lng: n.lon }))
  if (!nodos.length) return null
  // Varios nodos juntos = la misma esquina (avenidas de doble mano); lejos = esquinas distintas.
  if (nodos.some(n => distanciaMetros(nodos[0], n) > 300)) {
    return { estado: 'ambigua', lat: null, lng: null, detalle: `Hay más de una esquina ${calle1} y ${calle2}` }
  }
  const lat = nodos.reduce((s, n) => s + n.lat, 0) / nodos.length
  const lng = nodos.reduce((s, n) => s + n.lng, 0) / nodos.length
  return { estado: 'cruce', lat, lng, detalle: `Esquina ${tituloCase(calle1)} y ${tituloCase(calle2)}` }
}

// Texto de la consulta principal (para logs del backfill).
function armarConsulta({ calle, numero }) {
  const d = analizarDireccion(calle, numero)
  if (!d.calle) return ''
  if (d.esLote) return `barrio "${d.barrio}"`
  if (d.cruce) return `esquina "${d.cruce[0]}" y "${d.cruce[1]}"`
  return [d.calle, d.altura].filter(Boolean).join(' ')
}

// Devuelve { estado, lat, lng, detalle }. Nunca tira excepción: quien llama decide qué
// hacer con el estado. `obra` se usa como último recurso (a veces trae la dirección).
async function geocodificarDireccion({ calle, numero, obra }) {
  const d = analizarDireccion(calle, numero)
  const obraTxt = String(obra || '').trim()
  if (!d.calle && !obraTxt) return { estado: 'sin_direccion', lat: null, lng: null }
  try {
    let aproximada = null   // mejor resultado aproximado encontrado hasta ahora
    let ambigua = null

    if (d.calle) {
      // 1) Esquina de dos calles
      if (d.cruce) {
        const r = await buscarCruce(d.cruce).catch(e => { console.error('Overpass:', e.message); return null })
        if (r?.estado === 'cruce') return r
        if (r?.estado === 'ambigua') ambigua = r
      }
      // 2) Dirección con altura / lugar con nombre (no aplica a manzana-lote)
      if (!d.esLote && !d.barrioExplicito) {
        const r = await buscarDireccion(d.cruce ? d.cruce[0] : d.calle, d.altura)
        if (r?.estado === 'ok') return r
        if (r?.estado === 'ambigua') ambigua = ambigua || r
        else if (r) aproximada = r
      }
      // 3) Barrio / country (manzana-lote, "B° ...", o nombres de barrio cargados como calle)
      if (d.barrio && !d.cruce && (d.esLote || d.barrioExplicito || !aproximada)) {
        const r = await buscarBarrio(d.barrio, d.esLote || d.barrioExplicito)
        if (r) return r
      }
      if (aproximada) return aproximada
    }
    // 4) La obra, que a veces trae la dirección ("Nueva Córdoba - San Lorenzo 501")
    if (obraTxt && obraTxt.toLowerCase() !== String(calle || '').trim().toLowerCase()) {
      const o = analizarDireccion(obraTxt.replace(/^.*?\s-\s/, ''), '')
      const m = /^(.*?)\s+(\d{1,5})$/.exec(o.calle)
      const r = await buscarDireccion(m ? m[1] : o.calle, m ? m[2] : '')
      if (r && (r.estado === 'ok' || r.estado === 'calle')) return r
    }
    return ambigua || { estado: 'sin_resultado', lat: null, lng: null }
  } catch (e) {
    console.error('Geocodificación falló:', e.message)
    return { estado: 'error', lat: null, lng: null }
  }
}

module.exports = { geocodificarDireccion, armarConsulta, analizarDireccion, variantesBarrio }
