'use strict'
const { query } = require('../config/db')

async function getConfig() {
  const { rows } = await query(`SELECT clave, valor FROM config_notificaciones`)
  const cfg = {}
  rows.forEach(r => { cfg[r.clave] = r.valor })
  return cfg
}

async function setConfig(clave, valor) {
  await query(`
    INSERT INTO config_notificaciones (clave, valor) VALUES (?, ?)
    ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor
  `, [clave, String(valor)])
}

async function emailActivo() {
  return (await getConfig()).email_activo === '1'
}

async function enviarEmail({ asunto, cuerpo, destinatarios } = {}) {
  const cfg = await getConfig()
  const dest = destinatarios || cfg.email_destinatarios || ''
  if (!(await emailActivo()) || !dest) {
    console.log(`[notificaciones] (diferido) ${asunto || 'sin asunto'} → ${dest || 'sin destinatarios'}`)
    return { enviado: false, motivo: 'email_diferido' }
  }
  console.log(`[notificaciones] (pendiente SMTP) ${asunto} → ${dest}`)
  return { enviado: false, motivo: 'smtp_no_configurado' }
}

async function umbrales() {
  const raw = (await getConfig()).umbral_dias || '90,60,30'
  return raw.split(',').map(n => parseInt(n.trim(), 10)).filter(Boolean).sort((a, b) => b - a)
}

module.exports = { getConfig, setConfig, emailActivo, enviarEmail, umbrales }
