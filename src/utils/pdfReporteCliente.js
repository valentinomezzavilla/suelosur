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

  const cFecha = left
  const cTipo  = left + width * 0.16
  const cDesc  = left + width * 0.34
  const wDebito  = width * 0.80
  const wCredito = width

  const drawHead = () => {
    doc.rect(left, y, width, 20).fill(B.FONDO)
    doc.fillColor(B.GRIS).fontSize(8).font('Helvetica-Bold')
    doc.text('FECHA', cFecha + 6, y + 6)
    doc.text('TIPO', cTipo, y + 6)
    doc.text('DESCRIPCIÓN', cDesc, y + 6)
    doc.text('DÉBITO', left, y + 6, { width: wDebito - 6, align: 'right' })
    doc.text('CRÉDITO', left, y + 6, { width: wCredito - 6, align: 'right' })
    y += 20
  }
  drawHead()

  if (!filas.length) {
    doc.fillColor(B.GRIS).fontSize(9).font('Helvetica').text('Sin movimientos en el período seleccionado.', left + 6, y + 8)
    y += 28
  } else {
    doc.font('Helvetica').fontSize(8.5)
    filas.forEach((f, i) => {
      const rowH = 18
      if (y + rowH > doc.page.height - doc.page.margins.bottom - 20) {
        doc.addPage(); y = doc.page.margins.top; drawHead(); doc.font('Helvetica').fontSize(8.5)
      }
      if (i % 2 === 1) doc.rect(left, y, width, rowH).fill('#fafafa')
      const esCredito = Number(f.monto) > 0
      const monto = B.money(Math.abs(Number(f.monto || 0)))
      doc.fillColor(B.TINTA).font('Helvetica').text(f.fecha || '', cFecha + 6, y + 5, { width: width * 0.16 - 8 })
      doc.fillColor(B.GRIS).text(f.tipo || '', cTipo, y + 5, { width: width * 0.18 - 4 })
      doc.fillColor(B.TINTA).text(f.desc || '', cDesc, y + 5, { width: width * 0.44, lineBreak: false })
      doc.fillColor(B.ROJO).text(esCredito ? '—' : monto, left, y + 5, { width: wDebito - 6, align: 'right' })
      doc.fillColor(B.VERDE).text(esCredito ? monto : '—', left, y + 5, { width: wCredito - 6, align: 'right' })
      y += rowH
    })
  }

  // ── Cierre ────────────────────────────────────────────────────
  doc.moveTo(left, y).lineTo(right, y).strokeColor(B.LINEA).lineWidth(1).stroke()
  y += 8
  doc.fillColor(B.TINTA).fontSize(11).font('Helvetica-Bold')
     .text('Saldo actual', left, y, { width: width * 0.80, align: 'right' })
     .fillColor(saldoColor)
     .text(saldoTxt, left, y, { width: wCredito - 6, align: 'right' })

  B.drawFooter(doc, { extra: `${filas.length} movimiento(s)` })
  doc.end()
}

module.exports = { generarReporteClientePDF }
