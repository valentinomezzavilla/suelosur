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

function generarEstadoCuentaPDF(res, { cliente, estado, periodoLabel, obraLabel }) {
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
    derecha: [
      { label: 'Período', valor: periodoLabel || '—' },
      ...(obraLabel ? [{ label: 'Obra', valor: obraLabel, color: TINTA }] : []),
    ],
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

  // Tabla de movimientos: columnas fijas salvo la descripción, que toma el resto
  const PAD = 6
  const GAP = 8
  const fijas = { fecha: 64, metodo: 50, debito: 56, credito: 56, saldo: 62 }
  const col = {}
  col.fecha = { x: left + PAD, w: fijas.fecha }
  col.saldo = { x: right - PAD - fijas.saldo, w: fijas.saldo }
  col.credito = { x: col.saldo.x - GAP - fijas.credito, w: fijas.credito }
  col.debito = { x: col.credito.x - GAP - fijas.debito, w: fijas.debito }
  col.metodo = { x: col.debito.x - GAP - fijas.metodo, w: fijas.metodo }
  col.desc = { x: col.fecha.x + col.fecha.w + GAP, w: 0 }
  col.desc.w = col.metodo.x - GAP - col.desc.x

  const encabezadoTabla = () => {
    doc.rect(left, y, width, 20).fill('#f3f4f6')
    doc.fillColor(GRIS).fontSize(8).font('Helvetica-Bold')
    doc.text('FECHA', col.fecha.x, y + 6, { width: col.fecha.w })
    doc.text('DESCRIPCIÓN', col.desc.x, y + 6, { width: col.desc.w })
    doc.text('MÉTODO', col.metodo.x, y + 6, { width: col.metodo.w })
    doc.text('DÉBITO', col.debito.x, y + 6, { width: col.debito.w, align: 'right' })
    doc.text('CRÉDITO', col.credito.x, y + 6, { width: col.credito.w, align: 'right' })
    doc.text('SALDO', col.saldo.x, y + 6, { width: col.saldo.w, align: 'right' })
    y += 20
  }
  encabezadoTabla()

  if (!estado.movimientos.length) {
    doc.fillColor(GRIS).font('Helvetica').fontSize(8.5).text('Sin movimientos en el período.', left + PAD, y + 8)
    y += 24
  } else {
    estado.movimientos.forEach((m, i) => {
      // La descripción se parte en varias líneas; la fila mide lo que ella necesite
      const desc = m.descripcion || ''
      doc.font('Helvetica').fontSize(8)
      const rowH = Math.max(doc.heightOfString(desc || ' ', { width: col.desc.w }), 10) + 9
      if (y + rowH > doc.page.height - 60) { doc.addPage(); y = 56; encabezadoTabla() }
      if (i % 2 === 1) doc.rect(left, y, width, rowH).fill('#fafafa')
      const ty = y + 5
      doc.fillColor(TINTA).font('Helvetica').fontSize(8)
      doc.text(fmtFechaHora(m.created_at), col.fecha.x, ty, { width: col.fecha.w, lineBreak: false })
      doc.text(desc, col.desc.x, ty, { width: col.desc.w })
      doc.fillColor(GRIS).text(metodoDe(m), col.metodo.x, ty, { width: col.metodo.w, lineBreak: false, ellipsis: true })
      doc.fillColor(ROJO).text(m.monto < 0 ? money(Math.abs(m.monto)) : '—', col.debito.x, ty, { width: col.debito.w, align: 'right', lineBreak: false })
      doc.fillColor(VERDE).text(m.monto > 0 ? money(m.monto) : '—', col.credito.x, ty, { width: col.credito.w, align: 'right', lineBreak: false })
      doc.fillColor(m.saldo < 0 ? ROJO : TINTA).font('Helvetica-Bold').text(money(m.saldo), col.saldo.x, ty, { width: col.saldo.w, align: 'right', lineBreak: false })
      y += rowH
    })
  }

  doc.moveTo(left, y).lineTo(right, y).strokeColor('#e5e7eb').stroke()
  y += 8
  doc.fillColor(TINTA).fontSize(10).font('Helvetica-Bold')
     .text('Saldo final del período', left, y, { width: col.credito.x - left, align: 'right' })
     .fillColor(estado.saldoFinal < 0 ? ROJO : VERDE)
     .text(money(estado.saldoFinal), left, y, { width: width - 6, align: 'right' })

  B.drawFooter(doc)

  doc.end()
}

module.exports = { generarEstadoCuentaPDF }
