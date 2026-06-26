'use strict'
// ─────────────────────────────────────────────────────────────────
// Reporte PDF genérico tipo tabla (pdfkit).
// generarTablaPDF(res, { titulo, subtitulo, columnas, filas, nombreArchivo })
//   columnas: [{ header, key, width(0-1 proporción)?, align?, money? }]
// ─────────────────────────────────────────────────────────────────
const PDFDocument = require('pdfkit')
const B = require('./pdfBrand')

const GRIS = B.GRIS
const TINTA = B.TINTA

const money = B.money

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

  // Encabezado de marca (con logo)
  let y = B.drawHeader(doc, {
    titulo,
    conRubro: false,
    derecha: subtitulo ? [subtitulo] : [],
  })

  const drawHeader = () => {
    doc.rect(left, y, width, 20).fill(B.FONDO)
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

  B.drawFooter(doc, { extra: `${filas.length} registro(s)` })

  doc.end()
}

module.exports = { generarTablaPDF }
