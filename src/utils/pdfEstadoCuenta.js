'use strict'
// ─────────────────────────────────────────────────────────────────
// Estado de cuenta (liquidación al cliente) en PDF (pdfkit).
// Diseño formal y sobrio: sin colores de acento, tabla con filetes finos,
// saldo anterior, totales y saldo final. No muestra el método de pago de cada
// movimiento: todo lo que figura se liquida en esta misma cuenta.
// ─────────────────────────────────────────────────────────────────
const PDFDocument = require('pdfkit')
const { fmtFecha, hoyISO } = require('./fecha')
const B = require('./pdfBrand')

const NEGRO = '#111111'
const GRIS_TEXTO = '#555555'
const GRIS_LINEA = '#c8c8c8'

// Importe sin símbolo (el encabezado aclara que son pesos): 1.234,50 / -1.234,50
const num = (n) => Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

function situacion(saldo) {
  if (saldo < 0) return { titulo: 'SALDO DEUDOR', detalle: 'a abonar por el cliente' }
  if (saldo > 0) return { titulo: 'SALDO A FAVOR', detalle: 'a favor del cliente' }
  return { titulo: 'CUENTA SALDADA', detalle: '' }
}

function generarEstadoCuentaPDF(res, { cliente, estado, periodoLabel, obraLabel }) {
  const doc = new PDFDocument({ size: 'A4', margin: 48, bufferPages: true })
  res.setHeader('Content-Type', 'application/pdf')
  res.setHeader('Content-Disposition', `inline; filename="estado-cuenta-${cliente.numero || 'cliente'}.pdf"`)
  doc.pipe(res)

  const left = doc.page.margins.left
  const right = doc.page.width - doc.page.margins.right
  const width = right - left
  const limiteY = doc.page.height - doc.page.margins.bottom - 24

  const linea = (y, grosor = 0.5, color = GRIS_LINEA) =>
    doc.moveTo(left, y).lineTo(right, y).lineWidth(grosor).strokeColor(color).stroke()

  // ── Encabezado: empresa a la izquierda, título del documento a la derecha ──
  const top = doc.page.margins.top
  let textoX = left
  if (B.HAY_LOGO) {
    try { doc.image(B.LOGO_PATH, left, top, { width: 40, height: 40 }); textoX = left + 52 } catch (_) { /* sin logo */ }
  }
  doc.fillColor(NEGRO).font('Helvetica-Bold').fontSize(13).text(B.EMPRESA.razon.toUpperCase(), textoX, top + 3, { lineBreak: false })
  doc.fillColor(GRIS_TEXTO).font('Helvetica').fontSize(8)
     .text(B.EMPRESA.rubro, textoX, top + 20, { lineBreak: false })
     .text(B.EMPRESA.lugar, textoX, top + 31, { lineBreak: false })

  doc.fillColor(NEGRO).font('Helvetica-Bold').fontSize(14)
     .text('ESTADO DE CUENTA', left, top + 3, { width, align: 'right', lineBreak: false })
  doc.fillColor(GRIS_TEXTO).font('Helvetica').fontSize(8)
     .text('Liquidación de cuenta corriente', left, top + 22, { width, align: 'right', lineBreak: false })
     .text(`Fecha de emisión: ${fmtFecha(hoyISO())}`, left, top + 33, { width, align: 'right', lineBreak: false })

  let y = top + 52
  linea(y, 1.2, NEGRO)
  y += 14

  // ── Datos del cliente y del período ──
  const nombre = `${cliente.nombre} ${cliente.apellido || ''}`.trim()
  const mitad = width / 2
  const dato = (label, valor, x, yy, ancho, negrita = false) => {
    doc.fillColor(GRIS_TEXTO).font('Helvetica').fontSize(8).text(label, x, yy, { width: 62, lineBreak: false })
    doc.fillColor(NEGRO).font(negrita ? 'Helvetica-Bold' : 'Helvetica').fontSize(9)
       .text(valor, x + 66, yy - 0.5, { width: ancho - 66, lineBreak: false, ellipsis: true })
  }
  const izq = [['Cliente', nombre, true]]
  if (cliente.numero)   izq.push(['N° de cliente', String(cliente.numero)])
  if (cliente.telefono) izq.push(['Teléfono', String(cliente.telefono)])
  const der = [['Período', periodoLabel || '—']]
  if (obraLabel) der.push(['Obra', obraLabel])

  const filasDatos = Math.max(izq.length, der.length)
  izq.forEach(([l, v, neg], i) => dato(l, v, left, y + i * 15, mitad - 12, neg))
  der.forEach(([l, v], i) => dato(l, v, left + mitad, y + i * 15, mitad))
  y += filasDatos * 15 + 8
  linea(y)
  y += 16

  // ── Tabla de movimientos ──
  const PAD = 4
  const GAP = 10
  const fijas = { fecha: 56, debito: 68, credito: 68, saldo: 74 }
  const col = {}
  col.fecha   = { x: left + PAD, w: fijas.fecha }
  col.saldo   = { x: right - PAD - fijas.saldo, w: fijas.saldo }
  col.credito = { x: col.saldo.x - GAP - fijas.credito, w: fijas.credito }
  col.debito  = { x: col.credito.x - GAP - fijas.debito, w: fijas.debito }
  col.desc    = { x: col.fecha.x + col.fecha.w + GAP, w: 0 }
  col.desc.w  = col.debito.x - GAP - col.desc.x

  const encabezadoTabla = () => {
    linea(y, 0.8, NEGRO)
    doc.fillColor(NEGRO).font('Helvetica-Bold').fontSize(7.5)
    doc.text('FECHA', col.fecha.x, y + 7, { width: col.fecha.w, lineBreak: false })
    doc.text('CONCEPTO', col.desc.x, y + 7, { width: col.desc.w, lineBreak: false })
    doc.text('DÉBITO', col.debito.x, y + 7, { width: col.debito.w, align: 'right', lineBreak: false })
    doc.text('CRÉDITO', col.credito.x, y + 7, { width: col.credito.w, align: 'right', lineBreak: false })
    doc.text('SALDO', col.saldo.x, y + 7, { width: col.saldo.w, align: 'right', lineBreak: false })
    y += 21
    linea(y, 0.8, NEGRO)
  }
  doc.fillColor(GRIS_TEXTO).font('Helvetica-Oblique').fontSize(7.5)
     .text('Importes expresados en pesos argentinos ($)', left, y - 2, { width, align: 'right', lineBreak: false })
  y += 12
  encabezadoTabla()

  // Saldo anterior: punto de partida del período
  const ALTO_MIN = 10
  doc.fillColor(NEGRO).font('Helvetica-Oblique').fontSize(8.5)
  doc.text('Saldo anterior', col.desc.x, y + 6, { width: col.desc.w, lineBreak: false })
  doc.font('Helvetica').text(num(estado.saldoInicial), col.saldo.x, y + 6, { width: col.saldo.w, align: 'right', lineBreak: false })
  y += ALTO_MIN + 12
  linea(y)

  if (!estado.movimientos.length) {
    doc.fillColor(GRIS_TEXTO).font('Helvetica').fontSize(8.5).text('Sin movimientos en el período.', col.desc.x, y + 8, { lineBreak: false })
    y += 26
  } else {
    estado.movimientos.forEach((m) => {
      // El concepto se parte en varias líneas; la fila mide lo que necesite
      const desc = m.descripcion || ''
      doc.font('Helvetica').fontSize(8.5)
      const rowH = Math.max(doc.heightOfString(desc || ' ', { width: col.desc.w }), ALTO_MIN) + 12
      if (y + rowH > limiteY - 70) { doc.addPage(); y = doc.page.margins.top; encabezadoTabla() }
      const ty = y + 6
      doc.fillColor(NEGRO).font('Helvetica').fontSize(8.5)
      doc.text(fmtFecha(m.created_at), col.fecha.x, ty, { width: col.fecha.w, lineBreak: false })
      doc.text(desc, col.desc.x, ty, { width: col.desc.w })
      if (m.monto < 0) doc.text(num(Math.abs(m.monto)), col.debito.x, ty, { width: col.debito.w, align: 'right', lineBreak: false })
      if (m.monto > 0) doc.text(num(m.monto), col.credito.x, ty, { width: col.credito.w, align: 'right', lineBreak: false })
      doc.text(num(m.saldo), col.saldo.x, ty, { width: col.saldo.w, align: 'right', lineBreak: false })
      y += rowH
      linea(y)
    })
  }

  // ── Totales y saldo final ──
  if (y + 64 > limiteY) { doc.addPage(); y = doc.page.margins.top }
  linea(y, 0.8, NEGRO)
  doc.fillColor(NEGRO).font('Helvetica-Bold').fontSize(8.5)
  doc.text('TOTALES DEL PERÍODO', col.desc.x, y + 7, { width: col.desc.w, lineBreak: false })
  doc.text(num(estado.debitos), col.debito.x, y + 7, { width: col.debito.w, align: 'right', lineBreak: false })
  doc.text(num(estado.creditos), col.credito.x, y + 7, { width: col.credito.w, align: 'right', lineBreak: false })
  y += 24
  linea(y, 0.8, NEGRO)
  y += 14

  const sit = situacion(estado.saldoFinal)
  const cajaW = 250
  const cajaX = right - cajaW
  doc.rect(cajaX, y, cajaW, 38).lineWidth(1).strokeColor(NEGRO).stroke()
  doc.fillColor(NEGRO).font('Helvetica-Bold').fontSize(8.5).text(sit.titulo, cajaX + 10, y + 8, { width: cajaW - 20, lineBreak: false })
  if (sit.detalle) {
    doc.fillColor(GRIS_TEXTO).font('Helvetica').fontSize(7.5).text(sit.detalle, cajaX + 10, y + 21, { width: cajaW - 20, lineBreak: false })
  }
  doc.fillColor(NEGRO).font('Helvetica-Bold').fontSize(14)
     .text(`$ ${num(Math.abs(estado.saldoFinal))}`, cajaX + 10, y + 11, { width: cajaW - 20, align: 'right', lineBreak: false })

  // ── Pie con numeración de páginas ──
  const { start, count } = doc.bufferedPageRange()
  for (let i = 0; i < count; i++) {
    doc.switchToPage(start + i)
    const fy = doc.page.height - doc.page.margins.bottom - 10
    linea(fy - 6)
    doc.fillColor(GRIS_TEXTO).font('Helvetica').fontSize(7)
       .text(`${B.EMPRESA.razon} · Estado de cuenta de ${nombre}`, left, fy, { width: width - 80, align: 'left', lineBreak: false, ellipsis: true })
       .text(`Página ${i + 1} de ${count}`, right - 80, fy, { width: 80, align: 'right', lineBreak: false })
  }

  doc.end()
}

module.exports = { generarEstadoCuentaPDF }
