'use strict'
// ─────────────────────────────────────────────────────────────────
// Factura electrónica AFIP / ARCA — WSAA (login) + WSFEv1 (CAE).
// Los datos (CUIT, punto de venta, certificado, clave, entorno) se cargan en
// Facturación › Configuración; mientras estén incompletos queda apagada.
// ─────────────────────────────────────────────────────────────────
const https = require('https')
const forge = require('node-forge')
const { query } = require('../config/db')
const ConfigFacturacion = require('../models/config_facturacion.model')

const URLS = {
  homologacion: {
    wsaa: 'https://wsaahomo.afip.gov.ar/ws/services/LoginCms',
    wsfe: 'https://wswhomo.afip.gov.ar/wsfev1/service.asmx',
  },
  produccion: {
    wsaa: 'https://wsaa.afip.gov.ar/ws/services/LoginCms',
    wsfe: 'https://servicios1.afip.gov.ar/wsfev1/service.asmx',
  },
}

const CBTE_TIPO   = { A: 1, B: 6, C: 11 }
const NC_TIPO     = { A: 3, B: 8, C: 13 }
const COND_IVA_ID = { RI: 1, EX: 4, CF: 5, MT: 6 }
const ALIC_ID     = { 0: 3, 10.5: 4, 21: 5, 27: 6 }

const pad = (n, len) => String(n).padStart(len, '0')
const importe = (n) => (Math.round((Number(n) || 0) * 100) / 100).toFixed(2)
const yyyymmdd = (iso) => String(iso).slice(0, 10).replace(/-/g, '')
const isoDesdeAfip = (v) => v && /^\d{8}$/.test(v) ? `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}` : v

async function config() {
  const c = await ConfigFacturacion.obtener()
  return {
    cuit:      c.cuit || '',
    ptoVta:    c.pto_vta || 0,
    cert:      c.cert || '',
    key:       c.key || '',
    entorno:   c.entorno,
    condicion: c.condicion_iva,
  }
}

async function habilitado() {
  const c = await config()
  return !!(c.cuit && c.ptoVta && c.cert && c.key)
}

const entorno = async () => (await config()).entorno

const unescapeXml = (s) => String(s)
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
const tagRe = (name, flags) => new RegExp(`<(?:[\\w-]+:)?${name}>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`, flags)
const tag = (xml, name) => { const m = String(xml).match(tagRe(name)); return m ? m[1].trim() : null }
const tags = (xml, name) => [...String(xml).matchAll(tagRe(name, 'g'))].map(m => m[1])

// Los servidores de AFIP usan claves DH cortas que OpenSSL 3 rechaza por defecto.
function soapPost(url, body, soapAction) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const req = https.request({
      method: 'POST',
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'SOAPAction': soapAction,
        'Content-Length': Buffer.byteLength(body),
      },
      ciphers: 'DEFAULT@SECLEVEL=1',
      timeout: 30000,
    }, (res) => {
      let data = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { data += c })
      res.on('end', () => resolve({ status: res.statusCode, body: data }))
    })
    req.on('timeout', () => req.destroy(new Error('AFIP no respondió a tiempo.')))
    req.on('error', (err) => reject(new Error(`AFIP: no se pudo conectar (${err.message}).`)))
    req.write(body)
    req.end()
  })
}

// Firma el TRA (ticket de requerimiento de acceso) como CMS/PKCS#7 con el certificado.
function firmarTRA(tra, certPem, keyPem) {
  const cert = forge.pki.certificateFromPem(certPem)
  const key  = forge.pki.privateKeyFromPem(keyPem)
  const p7 = forge.pkcs7.createSignedData()
  p7.content = forge.util.createBuffer(tra, 'utf8')
  p7.addCertificate(cert)
  p7.addSigner({
    key,
    certificate: cert,
    digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
      { type: forge.pki.oids.messageDigest },
      { type: forge.pki.oids.signingTime, value: new Date() },
    ],
  })
  p7.sign()
  return forge.util.encode64(forge.asn1.toDer(p7.toAsn1()).getBytes())
}

function construirTRA(ahora = Date.now()) {
  const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
  return '<?xml version="1.0" encoding="UTF-8"?>'
    + '<loginTicketRequest version="1.0"><header>'
    + `<uniqueId>${Math.floor(ahora / 1000)}</uniqueId>`
    + `<generationTime>${iso(ahora - 10 * 60000)}</generationTime>`
    + `<expirationTime>${iso(ahora + 10 * 60000)}</expirationTime>`
    + '</header><service>wsfe</service></loginTicketRequest>'
}

const memo = {}
const vigente = (ta) => ta && Date.parse(ta.expira) - Date.now() > 5 * 60000

// El ticket depende del certificado: se descarta al cambiar certificado, CUIT o entorno.
async function invalidarTA() {
  Object.keys(memo).forEach(k => delete memo[k])
  await query(`DELETE FROM afip_ta`)
}

async function obtenerTA() {
  const c = await config()
  if (vigente(memo[c.entorno])) return memo[c.entorno]
  const { rows } = await query(`SELECT token, sign, expira FROM afip_ta WHERE servicio = 'wsfe' AND entorno = ?`, [c.entorno])
  if (vigente(rows[0])) { memo[c.entorno] = rows[0]; return rows[0] }

  let cms
  try {
    cms = firmarTRA(construirTRA(), c.cert, c.key)
  } catch (_) {
    throw new Error('AFIP (login): no se pudo firmar con el certificado cargado. Revisá el certificado y la clave privada.')
  }
  const body = '<?xml version="1.0" encoding="UTF-8"?>'
    + '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:wsaa="http://wsaa.view.sua.dvadac.desein.afip.gov">'
    + `<soapenv:Header/><soapenv:Body><wsaa:loginCms><wsaa:in0>${cms}</wsaa:in0></wsaa:loginCms></soapenv:Body></soapenv:Envelope>`
  const res = await soapPost(URLS[c.entorno].wsaa, body, '""')
  const ret = tag(res.body, 'loginCmsReturn')
  if (!ret) {
    const fault = tag(res.body, 'faultstring')
    throw new Error(`AFIP (login): ${fault ? unescapeXml(fault) : `respuesta inesperada (HTTP ${res.status})`}`)
  }
  const ta = unescapeXml(ret)
  const nuevo = { token: tag(ta, 'token'), sign: tag(ta, 'sign'), expira: tag(ta, 'expirationTime') }
  if (!nuevo.token || !nuevo.sign) throw new Error('AFIP (login): el ticket de acceso vino incompleto.')
  await query(`
    INSERT INTO afip_ta (servicio, entorno, token, sign, expira) VALUES ('wsfe', ?, ?, ?, ?)
    ON CONFLICT (servicio, entorno) DO UPDATE SET token = EXCLUDED.token, sign = EXCLUDED.sign, expira = EXCLUDED.expira
  `, [c.entorno, nuevo.token, nuevo.sign, nuevo.expira])
  memo[c.entorno] = nuevo
  return nuevo
}

async function wsfe(metodo, interior) {
  const c = await config()
  const ta = await obtenerTA()
  const body = '<?xml version="1.0" encoding="utf-8"?>'
    + '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ar="http://ar.gov.afip.dif.FEV1/">'
    + `<soapenv:Header/><soapenv:Body><ar:${metodo}>`
    + `<ar:Auth><ar:Token>${ta.token}</ar:Token><ar:Sign>${ta.sign}</ar:Sign><ar:Cuit>${c.cuit}</ar:Cuit></ar:Auth>`
    + interior
    + `</ar:${metodo}></soapenv:Body></soapenv:Envelope>`
  const res = await soapPost(URLS[c.entorno].wsfe, body, `"http://ar.gov.afip.dif.FEV1/${metodo}"`)
  const fault = tag(res.body, 'faultstring')
  if (fault) throw new Error(`AFIP (${metodo}): ${unescapeXml(fault)}`)
  return res.body
}

const mensajes = (xml, bloque) => tags(xml, bloque)
  .map(b => `${tag(b, 'Code') || ''} ${unescapeXml(tag(b, 'Msg') || '')}`.trim())
  .filter(Boolean)

async function ultimoAutorizado(ptoVta, cbteTipo) {
  const xml = await wsfe('FECompUltimoAutorizado', `<ar:PtoVta>${ptoVta}</ar:PtoVta><ar:CbteTipo>${cbteTipo}</ar:CbteTipo>`)
  const errores = mensajes(xml, 'Err')
  if (errores.length) throw new Error(`AFIP: ${errores.join(' · ')}`)
  return Number(tag(xml, 'CbteNro')) || 0
}

// Arma el detalle del comprobante en el orden que exige el WSDL de WSFEv1.
function construirDetalle({ nro, concepto, docTipo, docNro, fecha, total, neto, iva, tipoLetra, alicuota, condicionIva, asociado, cuitEmisor }) {
  const f = yyyymmdd(fecha)
  const servicios = concepto !== 1
    ? `<ar:FchServDesde>${f}</ar:FchServDesde><ar:FchServHasta>${f}</ar:FchServHasta><ar:FchVtoPago>${f}</ar:FchVtoPago>`
    : ''
  const asoc = asociado
    ? '<ar:CbtesAsoc><ar:CbteAsoc>'
      + `<ar:Tipo>${CBTE_TIPO[asociado.tipoLetra]}</ar:Tipo><ar:PtoVta>${asociado.ptoVta}</ar:PtoVta>`
      + `<ar:Nro>${asociado.nro}</ar:Nro><ar:Cuit>${cuitEmisor}</ar:Cuit><ar:CbteFch>${yyyymmdd(asociado.fecha)}</ar:CbteFch>`
      + '</ar:CbteAsoc></ar:CbtesAsoc>'
    : ''
  const esC = tipoLetra === 'C'
  const ivaXml = esC ? '' : '<ar:Iva><ar:AlicIva>'
    + `<ar:Id>${ALIC_ID[alicuota] ?? 5}</ar:Id><ar:BaseImp>${importe(neto)}</ar:BaseImp><ar:Importe>${importe(iva)}</ar:Importe>`
    + '</ar:AlicIva></ar:Iva>'
  return '<ar:FECAEDetRequest>'
    + `<ar:Concepto>${concepto}</ar:Concepto><ar:DocTipo>${docTipo}</ar:DocTipo><ar:DocNro>${docNro}</ar:DocNro>`
    + `<ar:CbteDesde>${nro}</ar:CbteDesde><ar:CbteHasta>${nro}</ar:CbteHasta><ar:CbteFch>${f}</ar:CbteFch>`
    + `<ar:ImpTotal>${importe(total)}</ar:ImpTotal><ar:ImpTotConc>0.00</ar:ImpTotConc>`
    + `<ar:ImpNeto>${importe(esC ? total : neto)}</ar:ImpNeto><ar:ImpOpEx>0.00</ar:ImpOpEx>`
    + `<ar:ImpTrib>0.00</ar:ImpTrib><ar:ImpIVA>${importe(esC ? 0 : iva)}</ar:ImpIVA>`
    + servicios
    + '<ar:MonId>PES</ar:MonId><ar:MonCotiz>1</ar:MonCotiz>'
    + `<ar:CondicionIVAReceptorId>${COND_IVA_ID[condicionIva] || 5}</ar:CondicionIVAReceptorId>`
    + asoc
    + ivaXml
    + '</ar:FECAEDetRequest>'
}

// Emite una factura (o nota de crédito si notaCredito=true) y devuelve el CAE.
async function emitir({ tipoLetra, notaCredito = false, concepto, docTipo, docNro, condicionIva,
                        total, neto, iva, alicuota, fecha, asociado }) {
  if (!(await habilitado())) throw new Error('La facturación electrónica con AFIP no está configurada.')
  const c = await config()
  const cbteTipo = (notaCredito ? NC_TIPO : CBTE_TIPO)[tipoLetra]
  if (!cbteTipo) throw new Error(`Tipo de comprobante inválido: ${tipoLetra}`)
  const nro = (await ultimoAutorizado(c.ptoVta, cbteTipo)) + 1
  const detalle = construirDetalle({
    nro, concepto, docTipo, docNro, fecha, total, neto, iva, tipoLetra, alicuota, condicionIva, asociado, cuitEmisor: c.cuit,
  })
  const xml = await wsfe('FECAESolicitar',
    '<ar:FeCAEReq>'
    + `<ar:FeCabReq><ar:CantReg>1</ar:CantReg><ar:PtoVta>${c.ptoVta}</ar:PtoVta><ar:CbteTipo>${cbteTipo}</ar:CbteTipo></ar:FeCabReq>`
    + `<ar:FeDetReq>${detalle}</ar:FeDetReq>`
    + '</ar:FeCAEReq>')
  const cae = tag(xml, 'CAE')
  if (tag(xml, 'Resultado') !== 'A' || !cae) {
    const motivos = [...mensajes(xml, 'Err'), ...mensajes(xml, 'Obs')]
    throw new Error(`AFIP rechazó el comprobante${motivos.length ? ': ' + motivos.join(' · ') : '.'}`)
  }
  return {
    puntoVenta: c.ptoVta,
    nroCbte: nro,
    numero: `${pad(c.ptoVta, 4)}-${pad(nro, 8)}`,
    cae,
    caeVto: isoDesdeAfip(tag(xml, 'CAEFchVto')),
  }
}

// Login real + consulta del último comprobante: confirma certificado, CUIT y punto de venta.
async function probarConexion() {
  if (!(await habilitado())) throw new Error('Completá CUIT, punto de venta, certificado y clave privada antes de probar.')
  const c = await config()
  const ta = await obtenerTA()
  const letra = c.condicion === 'MT' ? 'C' : 'B'
  const ultimo = await ultimoAutorizado(c.ptoVta, CBTE_TIPO[letra])
  return { entorno: c.entorno, expira: ta.expira, letra, ptoVta: c.ptoVta, ultimo }
}

module.exports = { habilitado, entorno, emitir, probarConexion, invalidarTA, firmarTRA, construirTRA, construirDetalle }
