'use strict'
// ─────────────────────────────────────────────────────────────────
// Generación de remito en PDF (server-side) con pdfkit.
// Recibe un remito normalizado (RemitosModel.obtener) y lo escribe
// en el response como application/pdf.
// ─────────────────────────────────────────────────────────────────
const PDFDocument = require('pdfkit')
const { fmtFecha } = require('./fecha')

const AZUL = '#1c5bad'
const GRIS = '#6b7280'
const TINTA = '#1f2937'

const money = (n) => '$' + Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2 })

function generarRemitoPDF(res, r) {
  const doc = new PDFDocument({ size: 'A4', margin: 48 })
  const filename = `remito-${r.nro_remito ? '0001-' + String(r.nro_remito).padStart(8, '0') : 'OP-' + String(r.nro_op).padStart(4, '0')}.pdf`

  res.setHeader('Content-Type', 'application/pdf')
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`)
  doc.pipe(res)

  const left = doc.page.margins.left
  const right = doc.page.width - doc.page.margins.right
  const width = right - left

  // ── Encabezado ──────────────────────────────────────────────
  doc.fillColor(AZUL).fontSize(22).font('Helvetica-Bold').text('SUELOSUR', left, 48)
  doc.fillColor(GRIS).fontSize(8).font('Helvetica')
     .text('Áridos · Contenedores · Movimiento de suelo', left, 74)
     .text('Córdoba, Argentina', left, 86)

  doc.fillColor(TINTA).fontSize(16).font('Helvetica-Bold').text('REMITO', left, 48, { width, align: 'right' })
  const nroTxt = r.nro_remito ? '0001-' + String(r.nro_remito).padStart(8, '0') : 'OP-' + String(r.nro_op).padStart(4, '0')
  doc.fontSize(13).text(nroTxt, left, 68, { width, align: 'right' })
  doc.fillColor(GRIS).fontSize(8).font('Helvetica')
     .text(`OP interna: ${String(r.nro_op).padStart(4, '0')}`, left, 86, { width, align: 'right' })
     .text(`Fecha: ${fmtFecha(r.fecha_emision)}`, left, 98, { width, align: 'right' })

  doc.moveTo(left, 118).lineTo(right, 118).strokeColor('#e5e7eb').lineWidth(1).stroke()

  // ── Cliente / Atendido ──────────────────────────────────────
  let y = 132
  doc.fillColor(GRIS).fontSize(8).font('Helvetica-Bold').text('CLIENTE', left, y)
  doc.fillColor(TINTA).fontSize(12).font('Helvetica-Bold').text(r.cliente.nombre, left, y + 12)
  let yc = y + 28
  doc.fillColor(GRIS).fontSize(9).font('Helvetica')
  if (r.cliente.dni)       { doc.text(`DNI/CUIT: ${r.cliente.dni}`, left, yc); yc += 12 }
  if (r.cliente.domicilio) { doc.text(r.cliente.domicilio, left, yc); yc += 12 }
  if (r.cliente.telefono)  { doc.text(`Tel: ${r.cliente.telefono}`, left, yc); yc += 12 }

  const colR = left + width / 2
  doc.fillColor(GRIS).fontSize(8).font('Helvetica-Bold').text('ATENDIDO POR', colR, y, { width: width / 2, align: 'right' })
  doc.fillColor(TINTA).fontSize(10).font('Helvetica').text(r.administrativo || '—', colR, y + 12, { width: width / 2, align: 'right' })
  doc.fillColor(AZUL).fontSize(9).font('Helvetica-Bold').text(r.tipoLabel, colR, y + 26, { width: width / 2, align: 'right' })
  if (r.metodo_pago) {
    doc.fillColor(GRIS).fontSize(8).font('Helvetica').text(`Pago: ${r.metodo_pago.replace('_', ' ')}`, colR, y + 40, { width: width / 2, align: 'right' })
  }

  y = Math.max(yc, y + 56) + 10

  // ── Entrega (alquileres / flete) ────────────────────────────
  if (r.entrega && r.entrega.domicilio) {
    doc.fillColor(GRIS).fontSize(8).font('Helvetica-Bold').text('DOMICILIO DE ENTREGA', left, y)
    doc.fillColor(TINTA).fontSize(10).font('Helvetica')
       .text(r.entrega.domicilio + (r.entrega.zona ? `  (zona ${r.entrega.zona})` : ''), left, y + 12)
    y += 34
  }

  // ── Tabla de ítems ──────────────────────────────────────────
  const cols = { desc: left, cant: left + width * 0.50, unid: left + width * 0.62, pu: left + width * 0.74, sub: left }
  const wSub = width
  doc.rect(left, y, width, 20).fill('#f3f4f6')
  doc.fillColor(GRIS).fontSize(8).font('Helvetica-Bold')
  doc.text('DESCRIPCIÓN', cols.desc + 6, y + 6)
  doc.text('CANT.', cols.cant, y + 6, { width: width * 0.10, align: 'right' })
  doc.text('UNIDAD', cols.unid, y + 6, { width: width * 0.10, align: 'center' })
  doc.text('P. UNIT.', cols.pu, y + 6, { width: width * 0.12, align: 'right' })
  doc.text('SUBTOTAL', cols.sub, y + 6, { width: wSub - 6, align: 'right' })
  y += 20

  doc.font('Helvetica').fontSize(9).fillColor(TINTA)
  r.items.forEach((it, i) => {
    const rowH = 22
    if (i % 2 === 1) doc.rect(left, y, width, rowH).fill('#fafafa').fillColor(TINTA)
    doc.fillColor(TINTA).font('Helvetica-Bold').text(it.descripcion, cols.desc + 6, y + 6, { width: width * 0.48 })
    doc.font('Helvetica')
       .text(Number(it.cantidad).toLocaleString('es-AR'), cols.cant, y + 6, { width: width * 0.10, align: 'right' })
       .text(it.unidad || '', cols.unid, y + 6, { width: width * 0.10, align: 'center' })
       .text(money(it.precioUnit), cols.pu, y + 6, { width: width * 0.12, align: 'right' })
       .text(money(it.subtotal), cols.sub, y + 6, { width: wSub - 6, align: 'right' })
    y += rowH
  })

  // ── Total ───────────────────────────────────────────────────
  doc.moveTo(left, y).lineTo(right, y).strokeColor('#e5e7eb').lineWidth(1).stroke()
  y += 8
  doc.fillColor(TINTA).fontSize(11).font('Helvetica-Bold')
     .text('TOTAL', left, y, { width: width * 0.74, align: 'right' })
     .text(money(r.total), left, y, { width: wSub - 6, align: 'right' })
  y += 28

  // ── Observaciones ───────────────────────────────────────────
  if (r.observaciones) {
    doc.fillColor(GRIS).fontSize(8).font('Helvetica-Bold').text('OBSERVACIONES', left, y)
    doc.fillColor(TINTA).fontSize(9).font('Helvetica').text(r.observaciones, left, y + 12, { width })
    y += 12 + doc.heightOfString(r.observaciones, { width }) + 14
  }

  // ── Firmas ──────────────────────────────────────────────────
  const yFirma = Math.max(y + 40, doc.page.height - 130)
  const wFirma = (width - 40) / 2
  doc.moveTo(left, yFirma).lineTo(left + wFirma, yFirma).strokeColor('#9ca3af').stroke()
  doc.moveTo(right - wFirma, yFirma).lineTo(right, yFirma).strokeColor('#9ca3af').stroke()
  doc.fillColor(GRIS).fontSize(8).font('Helvetica')
     .text('Firma y aclaración cliente', left, yFirma + 6, { width: wFirma, align: 'center' })
     .text('Firma Suelosur', right - wFirma, yFirma + 6, { width: wFirma, align: 'center' })

  doc.end()
}

module.exports = { generarRemitoPDF }
