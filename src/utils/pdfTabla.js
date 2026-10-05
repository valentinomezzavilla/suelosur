'use strict'
// ─────────────────────────────────────────────────────────────────
// Reporte PDF genérico tipo tabla (pdfkit).
// generarTablaPDF(res, { titulo, subtitulo, columnas, filas, nombreArchivo })
//   columnas: [{ header, key, width(0-1 proporción)?, align?, money? }]
//   filas:    [{ key: valor, ..., _destacar? }]  (_destacar = renglón en negrita, p.ej. totales)
// ─────────────────────────────────────────────────────────────────
const PDFDocument = require('pdfkit')
const B = require('./pdfBrand')

const GRIS = B.GRIS
const TINTA = B.TINTA

const money = B.money

// Recorta el texto al ancho de la celda: sin esto un texto largo se pisa con la columna siguiente
function recortar(doc, texto, ancho) {
  if (doc.widthOfString(texto) <= ancho) return texto
  let t = texto
  while (t.length > 1 && doc.widthOfString(t + '…') > ancho) t = t.slice(0, -1)
  return t + '…'
}

// registros: cantidad a mostrar en el pie cuando hay filas que no son registros (totales, subtotales)
function generarTablaPDF(res, { titulo = 'Reporte', subtitulo = '', columnas = [], filas = [], nombreArchivo, registros } = {}) {
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

  // Las columnas de texto (alineadas a la izquierda) se parten en varias líneas y la
  // fila crece a lo que necesite; montos y columnas a la derecha/centro van en una línea.
  const envuelve = (c) => !c.money && (c.align || 'left') === 'left'
  const textoDe = (f, c) => {
    const v = f[c.key]
    if (c.money) return v == null || v === '' ? '' : money(v)
    return v == null ? '' : String(v)
  }
  const fuente = (f) => doc.font(f._destacar ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5)

  filas.forEach((f, idx) => {
    fuente(f)
    const altoTexto = columnas.reduce((max, c, i) =>
      envuelve(c) ? Math.max(max, doc.heightOfString(textoDe(f, c) || ' ', { width: anchos[i] - 8 })) : max, 10)
    const rowH = altoTexto + 8
    if (y + rowH > doc.page.height - 40) { doc.addPage(); y = 40; drawHeader(); fuente(f) }
    if (f._destacar) doc.rect(left, y, width, rowH).fill(B.FONDO)
    else if (idx % 2 === 1) doc.rect(left, y, width, rowH).fill('#fafafa')
    let x = left
    columnas.forEach((c, i) => {
      doc.fillColor(TINTA)
      if (envuelve(c)) {
        doc.text(textoDe(f, c), x + 4, y + 4, { width: anchos[i] - 8 })
      } else {
        const texto = recortar(doc, textoDe(f, c), anchos[i] - 8)
        // width solo cuando hace falta para alinear (derecha/centro): con el texto ya
        // recortado al ancho exacto de la celda, pdfkit puede igual partirlo en dos líneas
        // (lineBreak:false no lo evita cuando el width queda justo al límite).
        const opts = { align: c.align || 'left', lineBreak: false }
        if (c.align === 'right' || c.align === 'center') opts.width = anchos[i] - 8
        doc.text(texto, x + 4, y + 4, opts)
      }
      x += anchos[i]
    })
    y += rowH
  })

  B.drawFooter(doc, { extra: `${registros ?? filas.length} registro(s)` })

  doc.end()
}

module.exports = { generarTablaPDF }
