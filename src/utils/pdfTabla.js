'use strict'
// ─────────────────────────────────────────────────────────────────
// Reporte PDF genérico tipo tabla (pdfkit).
// generarTablaPDF(res, { titulo, subtitulo, columnas, filas, nombreArchivo })
//   columnas: [{ header, key, width(0-1 proporción)?, align?, money? }]
// ─────────────────────────────────────────────────────────────────
const PDFDocument = require('pdfkit')
const { fmtFechaHora } = require('./fecha')

const AZUL = '#1c5bad'
const GRIS = '#6b7280'
const TINTA = '#1f2937'

const money = (n) => '$' + Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2 })

function generarTablaPDF(res, { titulo = 'Reporte', subtitulo = '', columnas = [], filas = [], nombreArchivo } = {}) {
  const doc = new PDFDocument({ size: 'A4', margin: 40, layout: 'landscape' })
  res.setHeader('Content-Type', 'application/pdf')
  res.setHeader('Content-Disposition', `inline; filename="${nombreArchivo || 'reporte'}.pdf"`)
  doc.pipe(res)

  const left = doc.page.margins.left
  const right = doc.page.width - doc.page.margins.right
  const width = right - left

  // Reparto de anchos: usar width (proporción) si viene, repartir el resto en partes iguales
  const conAncho = columnas.filter(c => c.width).reduce((a, c) => a + c.width, 0)
  const sinAncho = columnas.filter(c => !c.width).length
  const restante = Math.max(0, 1 - conAncho)
  const propPorCol = sinAncho ? restante / sinAncho : 0
  const anchos = columnas.map(c => (c.width || propPorCol) * width)

  // Encabezado del documento
  doc.fillColor(AZUL).fontSize(16).font('Helvetica-Bold').text('SUELOSUR', left, 36)
  doc.fillColor(TINTA).fontSize(13).font('Helvetica-Bold').text(titulo, left, 36, { width, align: 'right' })
  if (subtitulo) doc.fillColor(GRIS).fontSize(9).font('Helvetica').text(subtitulo, left, 54, { width, align: 'right' })

  let y = 78

  const drawHeader = () => {
    doc.rect(left, y, width, 20).fill('#f3f4f6')
    doc.fillColor(GRIS).fontSize(8).font('Helvetica-Bold')
    let x = left
    columnas.forEach((c, i) => {
      doc.text(String(c.header).toUpperCase(), x + 4, y + 6, { width: anchos[i] - 8, align: c.align || 'left' })
      x += anchos[i]
    })
    y += 20
  }
  drawHeader()

  doc.font('Helvetica').fontSize(8.5)
  filas.forEach((f, idx) => {
    const rowH = 18
    if (y + rowH > doc.page.height - 40) { doc.addPage(); y = 40; drawHeader(); doc.font('Helvetica').fontSize(8.5) }
    if (idx % 2 === 1) doc.rect(left, y, width, rowH).fill('#fafafa')
    let x = left
    columnas.forEach((c, i) => {
      let v = f[c.key]
      if (c.money) v = money(v)
      else if (v == null) v = ''
      doc.fillColor(TINTA).text(String(v), x + 4, y + 5, { width: anchos[i] - 8, align: c.align || 'left', lineBreak: false })
      x += anchos[i]
    })
    y += rowH
  })

  doc.fillColor(GRIS).fontSize(7).font('Helvetica')
     .text(`${filas.length} registro(s) · Generado el ${fmtFechaHora(new Date().toISOString())} · Suelosur S.A.S.`,
           left, doc.page.height - 30, { width, align: 'center' })

  doc.end()
}

module.exports = { generarTablaPDF }
