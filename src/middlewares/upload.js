'use strict'
// ─────────────────────────────────────────────────────────────────
// Subida de remitos firmados (imagen o PDF) → data/uploads/remitos/
// Archivos fuera de /public: se sirven con auth vía controlador.
// ─────────────────────────────────────────────────────────────────
const path   = require('path')
const fs     = require('fs')
const crypto = require('crypto')
const multer = require('multer')

const DIR_REMITOS    = path.join(__dirname, '..', '..', 'data', 'uploads', 'remitos')
const DIR_DOCUMENTOS = path.join(__dirname, '..', '..', 'data', 'uploads', 'documentos')
fs.mkdirSync(DIR_REMITOS, { recursive: true })
fs.mkdirSync(DIR_DOCUMENTOS, { recursive: true })

const TIPOS_OK = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf']

const fileFilter = (req, file, cb) => {
  if (TIPOS_OK.includes(file.mimetype)) return cb(null, true)
  cb(new Error('Formato no permitido. Subí una imagen (JPG/PNG) o un PDF.'))
}

// Constructor genérico de uploader sobre disco
function makeUploader(dir, prefix) {
  const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, dir),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase() || ''
      const base = (req.params.id || prefix).replace(/[^a-z0-9-]/gi, '')
      cb(null, `${prefix}-${base}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}${ext}`)
    },
  })
  return multer({ storage, limits: { fileSize: 10 * 1024 * 1024 }, fileFilter })
}

// Remitos: subida EN MEMORIA. El buffer luego se persiste vía src/config/storage
// (Supabase Storage en producción, disco en desarrollo). Documentos siguen en disco.
const uploadRemito    = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 }, fileFilter })
const uploadDocumento = makeUploader(DIR_DOCUMENTOS, 'doc')

// Genera un nombre de archivo único y seguro conservando la extensión.
function nombreArchivo(prefix, refId, originalname) {
  const ext = path.extname(originalname || '').toLowerCase() || ''
  const base = String(refId || prefix).replace(/[^a-z0-9-]/gi, '')
  return `${prefix}-${base}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}${ext}`
}

module.exports = { uploadRemito, uploadDocumento, DIR_REMITOS, DIR_DOCUMENTOS, nombreArchivo }
