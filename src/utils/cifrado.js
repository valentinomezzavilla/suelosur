'use strict'
// Cifrado simétrico (AES-256-GCM) para secretos guardados en la base.
// La clave se deriva de CONFIG_SECRET (o SESSION_SECRET): si ese valor cambia,
// lo cifrado ya no se puede leer y hay que volver a cargarlo.
const crypto = require('crypto')

const clave = () => crypto.createHash('sha256')
  .update(String(process.env.CONFIG_SECRET || process.env.SESSION_SECRET || 'suelosur-dev-secret'))
  .digest()

function cifrar(texto) {
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv('aes-256-gcm', clave(), iv)
  const datos = Buffer.concat([c.update(String(texto), 'utf8'), c.final()])
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), datos.toString('base64')].join(':')
}

function descifrar(valor) {
  const [version, iv, tag, datos] = String(valor || '').split(':')
  if (version !== 'v1') throw new Error('Formato cifrado desconocido.')
  const d = crypto.createDecipheriv('aes-256-gcm', clave(), Buffer.from(iv, 'base64'))
  d.setAuthTag(Buffer.from(tag, 'base64'))
  return Buffer.concat([d.update(Buffer.from(datos, 'base64')), d.final()]).toString('utf8')
}

module.exports = { cifrar, descifrar }
