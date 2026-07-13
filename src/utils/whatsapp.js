'use strict'
// ═══════════════════════════════════════════════════════════════════
// whatsapp.js — Links "click-to-chat" (wa.me) para enviar mensajes.
// No envía nada por sí solo: genera el link que abre WhatsApp (web o app)
// con el mensaje ya escrito hacia el número indicado. El usuario presiona
// "Enviar". Sin costo ni API externa.
// ═══════════════════════════════════════════════════════════════════

const CODIGO_PAIS_DEFAULT = process.env.WHATSAPP_COD_PAIS || '54' // Argentina

// Normaliza un teléfono a formato internacional de WhatsApp (solo dígitos).
// Para Argentina, los celulares en WhatsApp llevan: 54 + 9 + área + número.
// Se asume que el número se carga "limpio" (área + número, ej: 3514001234).
// Devuelve null si no parece un teléfono válido.
function normalizarTelefonoAr(telefono, { codigoPais = CODIGO_PAIS_DEFAULT } = {}) {
  if (!telefono) return null
  let d = String(telefono).replace(/\D/g, '')       // solo dígitos
  if (!d) return null
  d = d.replace(/^00/, '')                           // prefijo internacional 00
  if (d.startsWith(codigoPais)) d = d.slice(codigoPais.length) // quitar código de país si vino
  d = d.replace(/^0/, '')                            // quitar 0 de larga distancia (0351…)
  d = d.replace(/^9/, '')                            // quitar 9 de celular (lo re-agregamos uniforme)
  if (d.length < 8) return null                      // demasiado corto para ser válido
  return `${codigoPais}9${d}`
}

// Construye el link https://wa.me/<num>?text=<msg>. Devuelve null si el
// teléfono no es válido.
function linkWhatsApp(telefono, texto = '') {
  const num = normalizarTelefonoAr(telefono)
  if (!num) return null
  return `https://wa.me/${num}?text=${encodeURIComponent(texto)}`
}

module.exports = { normalizarTelefonoAr, linkWhatsApp }
