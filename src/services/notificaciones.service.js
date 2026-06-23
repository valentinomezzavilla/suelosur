'use strict'
// ─────────────────────────────────────────────────────────────────
// Servicio de notificaciones — email DIFERIDO.
// La estructura está lista; el envío real queda detrás de un stub que
// se activa cuando se configure SMTP (instalar nodemailer + credenciales).
// ─────────────────────────────────────────────────────────────────
const db = require('../config/db')

function getConfig() {
  const rows = db.prepare(`SELECT clave, valor FROM config_notificaciones`).all()
  const cfg = {}
  rows.forEach(r => { cfg[r.clave] = r.valor })
  return cfg
}

function setConfig(clave, valor) {
  db.prepare(`
    INSERT INTO config_notificaciones (id, clave, valor) VALUES (lower(hex(randomblob(16))), ?, ?)
    ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor
  `).run(clave, String(valor))
}

function emailActivo() {
  return getConfig().email_activo === '1'
}

// Stub: cuando SMTP esté configurado, reemplazar por nodemailer.
async function enviarEmail({ asunto, cuerpo, destinatarios } = {}) {
  const cfg = getConfig()
  const dest = destinatarios || cfg.email_destinatarios || ''
  if (!emailActivo() || !dest) {
    console.log(`[notificaciones] (diferido) ${asunto || 'sin asunto'} → ${dest || 'sin destinatarios'}`)
    return { enviado: false, motivo: 'email_diferido' }
  }
  // TODO: integrar nodemailer aquí cuando haya credenciales SMTP.
  console.log(`[notificaciones] (pendiente SMTP) ${asunto} → ${dest}`)
  return { enviado: false, motivo: 'smtp_no_configurado' }
}

// Umbrales de días configurables (default 90/60/30)
function umbrales() {
  const raw = getConfig().umbral_dias || '90,60,30'
  return raw.split(',').map(n => parseInt(n.trim(), 10)).filter(Boolean).sort((a, b) => b - a)
}

module.exports = { getConfig, setConfig, emailActivo, enviarEmail, umbrales }
