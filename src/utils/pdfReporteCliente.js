'use strict'
// ─────────────────────────────────────────────────────────────────
// pdfReporteCliente.js — Reporte de cliente con diseño cuidado.
// Reemplaza la tabla genérica: ficha del cliente, tarjetas de resumen
// y tabla de movimientos con débitos/créditos diferenciados.
// ─────────────────────────────────────────────────────────────────
const PDFDocument = require('pdfkit')
const { fmtFecha } = require('./fecha')
const B = require('./pdfBrand')

function generarReporteClientePDF(res, { cliente, periodoLabel, resumen, filas = [], nombreArchivo }) {
  const doc = new PDFDocument({ size: 'A4', margin: 48 })
  res.setHeader('Content-Type', 'application/pdf')
  res.setHeader('Content-Disposition', `inline; filename="${nombreArchivo || 'reporte-cliente'}.pdf"`)
  doc.pipe(res)

  const left = doc.page.margins.left
  const right = doc.page.width - doc.page.margins.right
  const width = right - left

  // ── Encabezado de marca ───────────────────────────────────────
  let y = B.drawHeader(doc, {
    titulo: 'Reporte de cliente',
    derecha: [{ label: 'Período', valor: periodoLabel || 'Histórico completo' }],
  })

  // ── Ficha del cliente ─────────────────────────────────────────
  const nombre = (cliente.nombreCompleto || `${cliente.nombre || ''} ${cliente.apellido || ''}`).trim()
  doc.fillColor(B.GRIS).fontSize(8).font('Helvetica-Bold').text('CLIENTE', left, y)
  doc.fillColor(B.TINTA).fontSize(14).font('Helvetica-Bold').text(nombre, left, y + 12)

  const datos = []
  if (cliente.numero != null) datos.push(`N° ${cliente.numero}`)
  if (cliente.dni)            datos.push(`DNI/CUIT ${cliente.dni}`)
  if (cliente.telefono || cliente.tel_whatsapp) datos.push(`Tel ${cliente.telefono || cliente.tel_whatsapp}`)
  if (cliente.domicilio_ppal) datos.push(cliente.domicilio_ppal)
  if (datos.length) {
    doc.fillColor(B.GRIS).fontSize(9).font('Helvetica').text(datos.join('  ·  '), left, y + 32, { width })
  }
  y += 56

  // ── Tarjetas de resumen ───────────────────────────────────────
  const saldo = Number(resumen.saldo || 0)
  const saldoColor = saldo < 0 ? B.ROJO : (saldo > 0 ? B.VERDE : B.TINTA)
  const saldoTxt = saldo < 0 ? `Debe ${B.money(Math.abs(saldo))}`
                 : saldo > 0 ? `A favor ${B.money(saldo)}`
                 : 'Al día'

  const cajas = [
    ['Transacciones', B.money(resumen.totalTransacciones), B.TINTA],
    ['Deudas (cargos)', B.money(Math.abs(resumen.totalDeuda)), B.ROJO],
    ['Pagos', B.money(resumen.totalPagos), B.VERDE],
    ['Saldo actual', saldoTxt, saldoColor],
  ]
  const gap = 8
  const cw = (width - gap * 3) / 4
  cajas.forEach((c, i) => {
    const x = left + i * (cw + gap)
    doc.roundedRect(x, y, cw, 52, 6).fill(B.FONDO)
    doc.fillColor(B.GRIS).fontSize(7.5).font('Helvetica-Bold').text(String(c[0]).toUpperCase(), x + 9, y + 9, { width: cw - 18 })
    doc.fillColor(c[2]).fontSize(12).font('Helvetica-Bold').text(c[1], x + 9, y + 26, { width: cw - 18 })
  })
  y += 74

  // ── Tabla de movimientos ──────────────────────────────────────
  doc.fillColor(B.TINTA).fontSize(10).font('Helvetica-Bold').text('Detalle de movimientos', left, y)
  y += 18

  // Columnas fijas salvo la descripción, que toma el resto
  const PAD = 6
  const GAP = 8
  const col = {}
  col.fecha   = { x: left + PAD, w: 46 }
  col.credito = { x: right - PAD - 62, w: 62 }
  col.debito  = { x: col.credito.x - GAP - 62, w: 62 }
  col.tipo    = { x: col.debito.x - GAP - 56, w: 56 }
  col.desc    = { x: col.fecha.x + col.fecha.w + GAP, w: 0 }
  col.desc.w  = col.tipo.x - GAP - col.desc.x

  const drawHead = () => {
    doc.rect(left, y, width, 20).fill(B.FONDO)
    doc.fillColor(B.GRIS).fontSize(8).font('Helvetica-Bold')
    doc.text('FECHA', col.fecha.x, y + 6, { width: col.fecha.w })
    doc.text('DESCRIPCIÓN', col.desc.x, y + 6, { width: col.desc.w })
    doc.text('TIPO', col.tipo.x, y + 6, { width: col.tipo.w })
    doc.text('DÉBITO', col.debito.x, y + 6, { width: col.debito.w, align: 'right' })
    doc.text('CRÉDITO', col.credito.x, y + 6, { width: col.credito.w, align: 'right' })
    y += 20
  }
  drawHead()

  if (!filas.length) {
    doc.fillColor(B.GRIS).fontSize(9).font('Helvetica').text('Sin movimientos en el período seleccionado.', left + PAD, y + 8)
    y += 28
  } else {
    filas.forEach((f, i) => {
      // La descripción se parte en varias líneas; la fila mide lo que ella necesite
      const desc = f.desc || ''
      doc.font('Helvetica').fontSize(8.5)
      const rowH = Math.max(doc.heightOfString(desc || ' ', { width: col.desc.w }), 10) + 9
      if (y + rowH > doc.page.height - doc.page.margins.bottom - 20) {
        doc.addPage(); y = doc.page.margins.top; drawHead(); doc.font('Helvetica').fontSize(8.5)
      }
      if (i % 2 === 1) doc.rect(left, y, width, rowH).fill('#fafafa')
      const esCredito = Number(f.monto) > 0
      const monto = B.money(Math.abs(Number(f.monto || 0)))
      const ty = y + 5
      doc.fillColor(B.TINTA).text(f.fecha || '', col.fecha.x, ty, { width: col.fecha.w, lineBreak: false })
      doc.text(desc, col.desc.x, ty, { width: col.desc.w })
      doc.fillColor(B.GRIS).text(f.tipo || '', col.tipo.x, ty, { width: col.tipo.w, lineBreak: false, ellipsis: true })
      doc.fillColor(B.ROJO).text(esCredito ? '—' : monto, col.debito.x, ty, { width: col.debito.w, align: 'right', lineBreak: false })
      doc.fillColor(B.VERDE).text(esCredito ? monto : '—', col.credito.x, ty, { width: col.credito.w, align: 'right', lineBreak: false })
      y += rowH
    })
  }

  // ── Cierre ────────────────────────────────────────────────────
  doc.moveTo(left, y).lineTo(right, y).strokeColor(B.LINEA).lineWidth(1).stroke()
  y += 8
  doc.fillColor(B.TINTA).fontSize(11).font('Helvetica-Bold')
     .text('Saldo actual', left, y, { width: col.debito.x - GAP - left, align: 'right' })
     .fillColor(saldoColor)
     .text(saldoTxt, col.debito.x, y, { width: right - PAD - col.debito.x, align: 'right' })

  B.drawFooter(doc, { extra: `${filas.length} movimiento(s)` })
  doc.end()
}

module.exports = { generarReporteClientePDF }
