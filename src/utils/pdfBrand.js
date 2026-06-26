'use strict'
// ─────────────────────────────────────────────────────────────────
// pdfBrand.js — Identidad visual compartida para todos los PDF.
// Centraliza colores, logo y los bloques de encabezado/pie de página
// para que TODOS los documentos (remitos, reportes, estados de cuenta)
// luzcan consistentes y lleven siempre el logo de la empresa.
// ─────────────────────────────────────────────────────────────────
const path = require('path')
const fs = require('fs')
const { fmtFechaHora } = require('./fecha')

// Paleta de marca
const AZUL   = '#1c5bad'
const NARANJA = '#e8912a'
const GRIS   = '#6b7280'
const TINTA  = '#1f2937'
const ROJO   = '#b91c1c'
const VERDE  = '#15803d'
const LINEA  = '#e5e7eb'
const FONDO  = '#f3f4f6'

const LOGO_PATH = path.join(__dirname, '..', '..', 'public', 'img', 'suelosurjpg.jpg')
const HAY_LOGO = fs.existsSync(LOGO_PATH)

const EMPRESA = {
  nombre: 'SUELOSUR',
  razon:  'Suelosur S.A.S.',
  rubro:  'Áridos · Contenedores · Movimiento de suelo',
  lugar:  'Córdoba, Argentina',
}

const money = (n) => '$' + Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2 })

// ── Encabezado de marca ────────────────────────────────────────
// Dibuja el logo + nombre de empresa a la izquierda, y un bloque de
// título (con líneas opcionales) alineado a la derecha.
// Devuelve la coordenada Y donde termina el encabezado.
//   opts = { titulo, derecha: [ {label, valor, color?} | string ], conRubro }
function drawHeader(doc, { titulo = '', derecha = [], conRubro = true } = {}) {
  const left = doc.page.margins.left
  const right = doc.page.width - doc.page.margins.right
  const width = right - left
  const top = doc.page.margins.top

  // Logo (cae con gracia a solo-texto si no está el archivo)
  const logoSize = 42
  let textoX = left
  if (HAY_LOGO) {
    try {
      doc.image(LOGO_PATH, left, top, { width: logoSize, height: logoSize })
      textoX = left + logoSize + 12
    } catch (_) { /* si falla, seguimos sin logo */ }
  }

  // Nombre y datos de la empresa
  doc.fillColor(AZUL).fontSize(19).font('Helvetica-Bold').text(EMPRESA.nombre, textoX, top + 2)
  if (conRubro) {
    doc.fillColor(GRIS).fontSize(7.5).font('Helvetica')
       .text(EMPRESA.rubro, textoX, top + 24)
       .text(EMPRESA.lugar, textoX, top + 34)
  }

  // Bloque derecho (título + líneas tipo label/valor)
  if (titulo) {
    doc.fillColor(TINTA).fontSize(16).font('Helvetica-Bold')
       .text(titulo.toUpperCase(), left, top + 2, { width, align: 'right' })
  }
  let yd = top + 24
  derecha.forEach((d) => {
    if (typeof d === 'string') {
      doc.fillColor(GRIS).fontSize(8.5).font('Helvetica').text(d, left, yd, { width, align: 'right' })
      yd += 12
    } else {
      const txt = `${d.label ? d.label + ': ' : ''}${d.valor ?? ''}`
      doc.fillColor(d.color || GRIS).fontSize(d.size || 9).font(d.bold ? 'Helvetica-Bold' : 'Helvetica')
         .text(txt, left, yd, { width, align: 'right' })
      yd += (d.size || 9) + 4
    }
  })

  const yFin = Math.max(top + logoSize + 6, yd) + 6
  doc.moveTo(left, yFin).lineTo(right, yFin).strokeColor(LINEA).lineWidth(1).stroke()
  return yFin + 14
}

// ── Pie de página de marca ─────────────────────────────────────
function drawFooter(doc, { extra = '' } = {}) {
  const left = doc.page.margins.left
  const right = doc.page.width - doc.page.margins.right
  const width = right - left
  const txt = `${extra ? extra + ' · ' : ''}Generado el ${fmtFechaHora(new Date().toISOString())} · ${EMPRESA.razon}`
  doc.fillColor(GRIS).fontSize(7).font('Helvetica')
     .text(txt, left, doc.page.height - doc.page.margins.bottom + 6, { width, align: 'center' })
}

module.exports = {
  AZUL, NARANJA, GRIS, TINTA, ROJO, VERDE, LINEA, FONDO,
  LOGO_PATH, HAY_LOGO, EMPRESA, money,
  drawHeader, drawFooter,
}
