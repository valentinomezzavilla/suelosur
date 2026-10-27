'use strict'
// Envío único: el mismo formulario no se registra dos veces (doble click, "atrás" y volver
// a enviar, recargar la página del POST…). public/js/appLoader.js le pone a cada formulario
// POST un código único (_envio) al enviarlo; acá se guarda la primera vez y, si el mismo
// código vuelve a llegar, el envío se descarta sin tocar nada.
//
// Si el envío terminó con error (mensaje de error o status >= 400), el código se libera
// para que se pueda corregir el formulario y volver a enviarlo.
const db = require('../config/db')

const VALIDO = /^[A-Za-z0-9-]{16,64}$/

const conError = (req, res, errorInicial) =>
  res.statusCode >= 400
  || (res.locals.error !== errorInicial && Array.isArray(res.locals.error) && res.locals.error.length > 0)
  || !!(req.session && req.session.flash && Array.isArray(req.session.flash.error) && req.session.flash.error.length)

module.exports = async function envioUnico(req, res, next) {
  if (req.method !== 'POST' || !req.body || req.body._envio === undefined) return next()
  const token = req.body._envio
  delete req.body._envio
  if (!req.session || !req.session.user || typeof token !== 'string' || !VALIDO.test(token)) return next()
  try {
    const nuevo = (await db.query(`INSERT INTO envios_formulario (token) VALUES (?) ON CONFLICT DO NOTHING RETURNING token`, [token])).rows.length
    if (!nuevo) {
      req.flash('warning', 'Ese formulario ya se había enviado: no se registró de nuevo. Si es un movimiento nuevo, cargalo otra vez.')
      return res.redirect(req.get('Referer') || '/')
    }
  } catch (e) {
    console.error('envioUnico:', e.message)   // sin la tabla (o sin base) no se frena el envío
    return next()
  }
  const errorInicial = res.locals.error
  res.on('finish', () => {
    if (conError(req, res, errorInicial)) db.query(`DELETE FROM envios_formulario WHERE token = ?`, [token]).catch(() => {})
  })
  next()
}
