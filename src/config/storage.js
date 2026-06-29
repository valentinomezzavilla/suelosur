'use strict'
// ═══════════════════════════════════════════════════════════════════
// storage.js — Almacenamiento de archivos (remitos, adjuntos).
//
// Usa Supabase Storage si está configurado (variables de entorno), y cae
// con gracia a disco local en desarrollo. Así los archivos sobreviven a los
// reinicios del servidor en producción (Render tiene filesystem efímero).
//
// Variables de entorno para activar Supabase Storage:
//   SUPABASE_URL                 https://<project-ref>.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY    clave service_role (solo backend, secreta)
//   SUPABASE_BUCKET              nombre del bucket (default: 'remitos')
// ═══════════════════════════════════════════════════════════════════
const path = require('path')
const fs = require('fs')

const DIR_REMITOS = path.join(__dirname, '..', '..', 'data', 'uploads', 'remitos')
fs.mkdirSync(DIR_REMITOS, { recursive: true })

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const BUCKET = process.env.SUPABASE_BUCKET || 'remitos'
const usaSupabase = !!(SUPABASE_URL && SUPABASE_KEY)

let supa = null
if (usaSupabase) {
  const { createClient } = require('@supabase/supabase-js')
  supa = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } })
  console.log('🗄️  Almacenamiento: Supabase Storage (bucket "' + BUCKET + '")')
} else {
  console.log('🗄️  Almacenamiento: disco local (configurá SUPABASE_URL para usar Supabase Storage)')
}

// Guarda un buffer y devuelve la clave (nombre) con la que se recupera luego.
async function guardar(buffer, filename, contentType) {
  if (usaSupabase) {
    const { error } = await supa.storage.from(BUCKET).upload(filename, buffer, {
      contentType: contentType || 'application/octet-stream',
      upsert: true,
    })
    if (error) throw new Error('Supabase Storage: ' + error.message)
    return filename
  }
  fs.writeFileSync(path.join(DIR_REMITOS, filename), buffer)
  return filename
}

// Devuelve el contenido del archivo como Buffer, o null si no existe.
async function leer(filename) {
  if (!filename) return null
  if (usaSupabase) {
    const { data, error } = await supa.storage.from(BUCKET).download(filename)
    if (error || !data) return null
    return Buffer.from(await data.arrayBuffer())
  }
  const p = path.join(DIR_REMITOS, filename)
  return fs.existsSync(p) ? fs.readFileSync(p) : null
}

// Elimina un archivo (silencioso si no existe).
async function borrar(filename) {
  if (!filename) return
  try {
    if (usaSupabase) { await supa.storage.from(BUCKET).remove([filename]); return }
    const p = path.join(DIR_REMITOS, filename)
    if (fs.existsSync(p)) fs.unlinkSync(p)
  } catch (e) { console.error('Error al borrar archivo:', e.message) }
}

module.exports = { guardar, leer, borrar, usaSupabase, DIR_REMITOS, BUCKET }
