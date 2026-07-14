'use strict'
// ─────────────────────────────────────────────────────────────────
// Resumen de cuenta corriente en PDF (pdfkit).
// ─────────────────────────────────────────────────────────────────
const PDFDocument = require('pdfkit')
const { fmtFechaHora } = require('./fecha')
const B = require('./pdfBrand')

const AZUL = B.AZUL
const GRIS = B.GRIS
const TINTA = B.TINTA
const ROJO = B.ROJO
const VERDE = B.VERDE

const money = B.money

const METODO_LABEL = { efectivo: 'Efectivo', transferencia: 'Transferencia', cheque: 'Cheque', cuenta_corriente: 'Cta. corriente' }
// Deudas = cargadas a cuenta corriente; pagos = método capturado; resto = —
const metodoDe = (m) => m.tipo === 'deuda' ? 'Cta. corriente' : (m.metodo_pago ? (METODO_LABEL[m.metodo_pago] || m.metodo_pago) : '—')

function generarEstadoCuentaPDF(res, { cliente, estado, periodoLabel }) {
  const doc = new PDFDocument({ size: 'A4', margin: 48 })
  res.setHeader('Content-Type', 'application/pdf')
  res.setHeader('Content-Disposition', `inline; filename="estado-cuenta-${cliente.numero || 'cliente'}.pdf"`)
  doc.pipe(res)

  const left = doc.page.margins.left
  const right = doc.page.width - doc.page.margins.right
  const width = right - left

  // Encabezado de marca (con logo)
  let y = B.drawHeader(doc, {
    titulo: 'Estado de cuenta',
    derecha: [{ label: 'Período', valor: periodoLabel || '—' }],
  })

  // Cliente
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
  doc.text('FECHA', left + 6, y + 6, { width: width * 0.16 })
  doc.text('DESCRIPCIÓN', left + width * 0.18, y + 6, { width: width * 0.26 })
  doc.text('MÉTODO', left + width * 0.45, y + 6, { width: width * 0.14 })
  doc.text('DÉBITO', left, y + 6, { width: width * 0.76, align: 'right' })
  doc.text('CRÉDITO', left, y + 6, { width: width * 0.88, align: 'right' })
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
         .text(fmtFechaHora(m.created_at), left + 6, y + 5, { width: width * 0.16, lineBreak: false })
         .text(m.descripcion || '', left + width * 0.18, y + 5, { width: width * 0.26, lineBreak: false, ellipsis: true })
      doc.fillColor(GRIS).text(metodoDe(m), left + width * 0.45, y + 5, { width: width * 0.14, lineBreak: false, ellipsis: true })
      doc.fillColor(ROJO).text(m.monto < 0 ? money(Math.abs(m.monto)) : '—', left, y + 5, { width: width * 0.76, align: 'right' })
      doc.fillColor(VERDE).text(m.monto > 0 ? money(m.monto) : '—', left, y + 5, { width: width * 0.88, align: 'right' })
      doc.fillColor(m.saldo < 0 ? ROJO : TINTA).font('Helvetica-Bold').text(money(m.saldo), left, y + 5, { width: width - 6, align: 'right' })
      y += rowH
    })
  }

  doc.moveTo(left, y).lineTo(right, y).strokeColor('#e5e7eb').stroke()
  y += 8
  doc.fillColor(TINTA).fontSize(10).font('Helvetica-Bold')
     .text('Saldo final del período', left, y, { width: width * 0.76, align: 'right' })
     .fillColor(estado.saldoFinal < 0 ? ROJO : VERDE)
     .text(money(estado.saldoFinal), left, y, { width: width - 6, align: 'right' })

  B.drawFooter(doc)

  doc.end()
}

module.exports = { generarEstadoCuentaPDF }
