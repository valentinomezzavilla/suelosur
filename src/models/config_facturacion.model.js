'use strict'
const forge = require('node-forge')
const { query } = require('../config/db')
const { cifrar, descifrar } = require('../utils/cifrado')

const CONDICIONES_EMPRESA = { RI: 'Responsable Inscripto', MT: 'Monotributista' }
const errorUsuario = (msg) => Object.assign(new Error(msg), { usuario: true })

// Acepta el .crt de AFIP en PEM, en DER (binario) o el base64 pegado sin encabezado.
function leerCertificado(entrada) {
  try {
    const texto = Buffer.isBuffer(entrada) ? entrada.toString('utf8') : String(entrada || '')
    const i = texto.indexOf('-----BEGIN CERTIFICATE-----')
    const cert = i >= 0
      ? forge.pki.certificateFromPem(texto.slice(i))
      : forge.pki.certificateFromAsn1(forge.asn1.fromDer(
          Buffer.isBuffer(entrada) ? entrada.toString('binary') : forge.util.decode64(texto.replace(/\s+/g, ''))))
    return forge.pki.certificateToPem(cert)
  } catch (_) {
    throw errorUsuario('El certificado no es válido. Subí el archivo .crt que descargaste de AFIP.')
  }
}

function leerClave(entrada) {
  const texto = Buffer.isBuffer(entrada) ? entrada.toString('utf8') : String(entrada || '')
  if (/ENCRYPTED/.test(texto)) {
    throw errorUsuario('La clave privada está protegida con contraseña. Usá la clave sin contraseña (el .key generado con openssl genrsa).')
  }
  const i = texto.indexOf('-----BEGIN')
  try {
    return forge.pki.privateKeyToPem(forge.pki.privateKeyFromPem(texto.slice(Math.max(i, 0))))
  } catch (_) {
    throw errorUsuario('La clave privada no es válida. Subí el archivo .key en formato PEM.')
  }
}

function coinciden(certPem, keyPem) {
  try {
    const cert = forge.pki.certificateFromPem(certPem)
    const key = forge.pki.privateKeyFromPem(keyPem)
    return cert.publicKey.n.compareTo(key.n) === 0
  } catch (_) {
    return false
  }
}

function huella(certPem) {
  const cert = forge.pki.certificateFromPem(certPem)
  const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes()
  return forge.md.sha256.create().update(der).digest().toHex()
}

function infoCertificado(certPem) {
  if (!certPem) return null
  try {
    const cert = forge.pki.certificateFromPem(certPem)
    const attr = (entidad, oid) => entidad.attributes.find(a => a.type === oid)?.value || null
    const hasta = cert.validity.notAfter
    const dias = Math.floor((hasta.getTime() - Date.now()) / 86400000)
    return {
      titular:       attr(cert.subject, '2.5.4.3'),
      organizacion:  attr(cert.subject, '2.5.4.10'),
      cuit:          (String(attr(cert.subject, '2.5.4.5') || '').match(/\d{11}/) || [null])[0],
      emisor:        attr(cert.issuer, '2.5.4.3'),
      desde:         cert.validity.notBefore.toISOString().slice(0, 10),
      hasta:         hasta.toISOString().slice(0, 10),
      diasRestantes: dias,
      vencido:       dias < 0,
      huella:        huella(certPem).slice(0, 16).toUpperCase().match(/.{2}/g).join(':'),
    }
  } catch (_) {
    return { invalido: true }
  }
}

// Caché corta: el servidor local y Render comparten la base.
let cache = null
let cacheHasta = 0

async function obtener() {
  if (cache && Date.now() < cacheHasta) return cache
  const row = (await query(`SELECT * FROM config_facturacion WHERE id = 1`)).rows[0] || {}
  let key = null
  let keyError = null
  if (row.key_cifrada) {
    try { key = descifrar(row.key_cifrada) } catch (_) {
      keyError = 'No se pudo leer la clave privada guardada (cambió el secreto del servidor). Volvé a cargarla.'
    }
  }
  cache = {
    cuit:          row.cuit || null,
    condicion_iva: row.condicion_iva === 'MT' ? 'MT' : 'RI',
    pto_vta:       row.pto_vta || null,
    entorno:       row.entorno === 'produccion' ? 'produccion' : 'homologacion',
    cert:          row.cert_pem || null,
    cert_huella:   row.cert_huella || null,
    key,
    keyError,
    updated_by:    row.updated_by || null,
    updated_at:    row.updated_at || null,
  }
  cacheHasta = Date.now() + 60000
  return cache
}

module.exports = {
  CONDICIONES_EMPRESA,
  leerCertificado, leerClave, coinciden, infoCertificado, huella,
  obtener,

  // Estado para la pantalla: nunca incluye la clave privada.
  async estado() {
    const c = await obtener()
    const faltan = []
    if (!c.cuit) faltan.push('CUIT')
    if (!c.pto_vta) faltan.push('punto de venta')
    if (!c.cert) faltan.push('certificado')
    if (!c.key) faltan.push('clave privada')
    const usuario = c.updated_by
      ? (await query(`SELECT nombre FROM users WHERE id = ?`, [c.updated_by])).rows[0]?.nombre || null
      : null
    return {
      cuit: c.cuit,
      condicion_iva: c.condicion_iva,
      pto_vta: c.pto_vta,
      entorno: c.entorno,
      tieneCert: !!c.cert,
      tieneKey: !!c.key,
      keyError: c.keyError,
      cert: infoCertificado(c.cert),
      faltan,
      completo: faltan.length === 0,
      updated_at: c.updated_at,
      usuario,
    }
  },

  async guardar({ cuit, condicion_iva, pto_vta, entorno, certPem, keyPem, quitarCredenciales }, usuario) {
    const sets = ['cuit = ?', 'condicion_iva = ?', 'pto_vta = ?', 'entorno = ?', 'updated_by = ?',
      `updated_at = to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')`]
    const vals = [cuit || null, condicion_iva, pto_vta || null, entorno, usuario || null]
    let nuevaHuella = null
    if (quitarCredenciales) {
      sets.push('cert_pem = NULL', 'cert_huella = NULL', 'key_cifrada = NULL')
    } else {
      if (certPem) {
        nuevaHuella = huella(certPem)
        sets.push('cert_pem = ?', 'cert_huella = ?')
        vals.push(certPem, nuevaHuella)
      }
      if (keyPem) {
        sets.push('key_cifrada = ?')
        vals.push(cifrar(keyPem))
      }
    }
    await query(`UPDATE config_facturacion SET ${sets.join(', ')} WHERE id = 1`, vals)
    cache = null
    return { huella: nuevaHuella }
  },
}
