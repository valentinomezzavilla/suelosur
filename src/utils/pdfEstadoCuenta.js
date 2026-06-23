'use strict'
// ─────────────────────────────────────────────────────────────────
// Resumen de cuenta corriente en PDF (pdfkit).
// ─────────────────────────────────────────────────────────────────
const PDFDocument = require('pdfkit')
const { fmtFechaHora } = require('./fecha')

const AZUL = '#1c5bad'
const GRIS = '#6b7280'
const TINTA = '#1f2937'
const ROJO = '#b91c1c'
const VERDE = '#15803d'

const money = (n) => '$' + Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2 })

function generarEstadoCuentaPDF(res, { cliente, estado, periodoLabel }) {
  const doc = new PDFDocument({ size: 'A4', margin: 48 })
  res.setHeader('Content-Type', 'application/pdf')
  res.setHeader('Content-Disposition', `inline; filename="estado-cuenta-${cliente.numero || 'cliente'}.pdf"`)
  doc.pipe(res)

  const left = doc.page.margins.left
  const right = doc.page.width - doc.page.margins.right
  const width = right - left

  // Encabezado
  doc.fillColor(AZUL).fontSize(20).font('Helvetica-Bold').text('SUELOSUR', left, 48)
  doc.fillColor(TINTA).fontSize(15).font('Helvetica-Bold').text('Estado de cuenta', left, 48, { width, align: 'right' })
  doc.fillColor(GRIS).fontSize(9).font('Helvetica').text(`Período: ${periodoLabel || '—'}`, left, 70, { width, align: 'right' })

  doc.moveTo(left, 92).lineTo(right, 92).strokeColor('#e5e7eb').stroke()

  // Cliente
  let y = 104
  doc.fillColor(GRIS).fontSize(8).font('Helvetica-Bold').text('CLIENTE', left, y)
  const nombre = `${cliente.nombre} ${cliente.apellido || ''}`.trim()
  doc.fillColor(TINTA).fontSize(13).font('Helvetica-Bold').text(nombre, left, y + 12)
  doc.fillColor(GRIS).fontSize(9).font('Helvetica')
  if (cliente.numero)   doc.text(`N° de cliente: ${cliente.numero}`, left, y + 30)
  if (cliente.telefono) doc.text(`Tel: ${cliente.telefono}`, left, y + 42)
  y += 64

  // Resumen
  const cajas = [
    ['Saldo inicial', money(estado.saldoInicial), TINTA],
    ['Débitos (cargos)', money(estado.debitos), ROJO],
    ['Créditos (pagos)', money(estado.creditos), VERDE],
    ['Saldo final', money(estado.saldoFinal), estado.saldoFinal < 0 ? ROJO : VERDE],
  ]
  const cw = (width - 18) / 4
  cajas.forEach((c, i) => {
    const x = left + i * (cw + 6)
    doc.roundedRect(x, y, cw, 48, 6).fill('#f3f4f6')
    doc.fillColor(GRIS).fontSize(7.5).font('Helvetica-Bold').text(c[0].toUpperCase(), x + 8, y + 8, { width: cw - 16 })
    doc.fillColor(c[2]).fontSize(12).font('Helvetica-Bold').text(c[1], x + 8, y + 24, { width: cw - 16 })
  })
  y += 70

  // Tabla de movimientos
  doc.rect(left, y, width, 20).fill('#f3f4f6')
  doc.fillColor(GRIS).fontSize(8).font('Helvetica-Bold')
  doc.text('FECHA', left + 6, y + 6)
  doc.text('DESCRIPCIÓN', left + width * 0.26, y + 6)
  doc.text('DÉBITO', left, y + 6, { width: width * 0.74, align: 'right' })
  doc.text('CRÉDITO', left, y + 6, { width: width * 0.87, align: 'right' })
  doc.text('SALDO', left, y + 6, { width: width - 6, align: 'right' })
  y += 20

  doc.font('Helvetica').fontSize(8.5)
  if (!estado.movimientos.length) {
    doc.fillColor(GRIS).text('Sin movimientos en el período.', left + 6, y + 8)
    y += 24
  } else {
    estado.movimientos.forEach((m, i) => {
      const rowH = 18
      if (y + rowH > doc.page.height - 60) { doc.addPage(); y = 56 }
      if (i % 2 === 1) doc.rect(left, y, width, rowH).fill('#fafafa')
      doc.fillColor(TINTA).font('Helvetica').fontSize(8)
         .text(fmtFechaHora(m.created_at), left + 6, y + 5, { width: width * 0.22 })
         .text(m.descripcion || '', left + width * 0.26, y + 5, { width: width * 0.40 })
      doc.fillColor(ROJO).text(m.monto < 0 ? money(Math.abs(m.monto)) : '—', left, y + 5, { width: width * 0.74, align: 'right' })
      doc.fillColor(VERDE).text(m.monto > 0 ? money(m.monto) : '—', left, y + 5, { width: width * 0.87, align: 'right' })
      doc.fillColor(m.saldo < 0 ? ROJO : TINTA).font('Helvetica-Bold').text(money(m.saldo), left, y + 5, { width: width - 6, align: 'right' })
      y += rowH
    })
  }

  doc.moveTo(left, y).lineTo(right, y).strokeColor('#e5e7eb').stroke()
  y += 8
  doc.fillColor(TINTA).fontSize(10).font('Helvetica-Bold')
     .text('Saldo final del período', left, y, { width: width * 0.74, align: 'right' })
     .fillColor(estado.saldoFinal < 0 ? ROJO : VERDE)
     .text(money(estado.saldoFinal), left, y, { width: width - 6, align: 'right' })

  doc.fillColor(GRIS).fontSize(7).font('Helvetica')
     .text(`Generado el ${fmtFechaHora(new Date().toISOString())} · Suelosur S.A.S.`, left, doc.page.height - 56, { width, align: 'center' })

  doc.end()
}

module.exports = { generarEstadoCuentaPDF }
