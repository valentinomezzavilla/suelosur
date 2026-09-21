'use strict'
// ─────────────────────────────────────────────────────────────────
// Recibo de sueldo / de pago a un empleado (PDF, pdfkit).
// generarReciboPDF(res, pago)  ← pago = PagosEmpleadoModel.obtenerConEmpleado()
// ─────────────────────────────────────────────────────────────────
const PDFDocument = require('pdfkit')
const B = require('./pdfBrand')
const { fmtFecha } = require('./fecha')
const { importeEnLetras } = require('./numeroALetras')

const GRIS = B.GRIS
const TINTA = B.TINTA
const money = B.money

const TIPO_LABEL = {
  sueldo: 'Sueldo', anticipo: 'Anticipo', viatico: 'Viático', horas_extra: 'Horas extra',
  bonificacion: 'Bonificación', descuento: 'Descuento', liquidacion: 'Liquidación',
}
const METODO = { efectivo: 'Efectivo', transferencia: 'Transferencia', cheque: 'Cheque' }
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre']

// "2026-09" → "Septiembre 2026"; cualquier otro texto se deja tal cual
function periodoLegible(periodo) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(periodo || '').trim())
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) return periodo || '—'
  const mes = MESES[Number(m[2]) - 1]
  return `${mes.charAt(0).toUpperCase()}${mes.slice(1)} ${m[1]}`
}

// N° de recibo legible, p.ej. REC-000012
const numeroRecibo = (pago) => `REC-${String(pago.id).padStart(6, '0')}`

// Renglones del recibo: haberes a la izquierda, descuentos a la derecha
function conceptos(pago) {
  const neto = Number(pago.monto) || 0
  const desc = Number(pago.descuentos) || 0
  const adic = Number(pago.adiciones) || 0
  // Pagos viejos (anteriores a los descuentos/adiciones) no tienen sueldo_base: el monto es el bruto
  const base = pago.sueldo_base != null ? Number(pago.sueldo_base) : neto
  const filas = [{ concepto: pago.tipo === 'sueldo' ? 'Sueldo básico' : (TIPO_LABEL[pago.tipo] || pago.tipo), haber: base }]
  if (adic > 0) filas.push({ concepto: 'Adiciones / bonificaciones', haber: adic })
  if (desc > 0) filas.push({ concepto: 'Descuentos', descuento: desc })
  return { filas, haberes: base + adic, descuentos: desc, neto }
}

function construirRecibo(doc, pago) {
  const left = doc.page.margins.left
  const right = doc.page.width - doc.page.margins.right
  const width = right - left
  const esSueldo = pago.tipo === 'sueldo' || pago.tipo === 'liquidacion'
  const nombre = `${pago.nombre || ''} ${pago.apellido || ''}`.trim()

  // ── Encabezado de marca ─────────────────────────────────────
  let y = B.drawHeader(doc, {
    titulo: esSueldo ? 'Recibo de sueldo' : 'Recibo de pago',
    derecha: [
      { valor: numeroRecibo(pago), bold: true, color: TINTA, size: 13 },
      { label: 'Fecha de pago', valor: fmtFecha(pago.fecha) },
      { label: 'Período', valor: periodoLegible(pago.periodo) },
    ],
  })

  // ── Empleador / empleado ────────────────────────────────────
  const mitad = width / 2 - 10
  const colDer = left + width / 2 + 10
  doc.fillColor(GRIS).fontSize(8).font('Helvetica-Bold').text('EMPLEADOR', left, y)
  doc.fillColor(TINTA).fontSize(11).font('Helvetica-Bold').text(B.EMPRESA.razon, left, y + 12, { width: mitad })
  doc.fillColor(GRIS).fontSize(9).font('Helvetica').text(B.EMPRESA.lugar, left, y + 27, { width: mitad })

  doc.fillColor(GRIS).fontSize(8).font('Helvetica-Bold').text('EMPLEADO', colDer, y)
  doc.fillColor(TINTA).fontSize(11).font('Helvetica-Bold').text(nombre, colDer, y + 12, { width: mitad })
  let ye = y + 27
  doc.fillColor(GRIS).fontSize(9).font('Helvetica')
  const datos = [
    pago.legajo != null ? `Legajo: ${pago.legajo}` : null,
    pago.dni ? `DNI: ${pago.dni}` : null,
    pago.cuil ? `CUIL: ${pago.cuil}` : null,
    pago.cargo || pago.categoria_laboral ? `Cargo: ${pago.cargo || pago.categoria_laboral}` : null,
    pago.fecha_ingreso ? `Ingreso: ${fmtFecha(pago.fecha_ingreso)}` : null,
  ].filter(Boolean)
  datos.forEach((d) => { doc.text(d, colDer, ye, { width: mitad }); ye += 12 })
  y = Math.max(y + 44, ye) + 14

  // ── Tabla de conceptos ──────────────────────────────────────
  const anchoNum = width * 0.2
  const colHaber = right - anchoNum * 2
  const colDesc = right - anchoNum
  doc.rect(left, y, width, 20).fill(B.FONDO)
  doc.fillColor(GRIS).fontSize(8).font('Helvetica-Bold')
  doc.text('CONCEPTO', left + 8, y + 6)
  doc.text('HABERES', colHaber, y + 6, { width: anchoNum - 8, align: 'right' })
  doc.text('DESCUENTOS', colDesc, y + 6, { width: anchoNum - 8, align: 'right' })
  y += 20

  const c = conceptos(pago)
  doc.font('Helvetica').fontSize(10)
  c.filas.forEach((f, i) => {
    if (i % 2 === 1) doc.rect(left, y, width, 24).fill('#fafafa')
    doc.fillColor(TINTA).text(f.concepto, left + 8, y + 7)
    if (f.haber != null) doc.text(money(f.haber), colHaber, y + 7, { width: anchoNum - 8, align: 'right' })
    if (f.descuento != null) doc.text(money(f.descuento), colDesc, y + 7, { width: anchoNum - 8, align: 'right' })
    y += 24
  })
  doc.moveTo(left, y).lineTo(right, y).strokeColor(B.LINEA).lineWidth(1).stroke()
  y += 10

  // Totales
  doc.font('Helvetica').fontSize(10).fillColor(GRIS)
  doc.text('Total haberes', left + 8, y)
  doc.fillColor(TINTA).text(money(c.haberes), colHaber, y, { width: anchoNum - 8, align: 'right' })
  doc.fillColor(TINTA).text(money(c.descuentos), colDesc, y, { width: anchoNum - 8, align: 'right' })
  y += 22

  doc.rect(left, y, width, 32).fill(B.FONDO)
  doc.fillColor(TINTA).fontSize(11).font('Helvetica-Bold').text('NETO A COBRAR', left + 8, y + 10)
  doc.fillColor(B.AZUL).fontSize(15).text(money(c.neto), left + width / 2, y + 8, { width: width / 2 - 8, align: 'right' })
  y += 46

  // Importe en letras
  doc.fillColor(GRIS).fontSize(8).font('Helvetica-Bold').text('SON', left, y)
  doc.fillColor(TINTA).fontSize(10).font('Helvetica').text(importeEnLetras(c.neto), left, y + 12, { width })
  y += 12 + doc.heightOfString(importeEnLetras(c.neto), { width }) + 14

  // Forma de pago y observaciones
  const pagoTxt = METODO[pago.metodo_pago] || pago.metodo_pago
  if (pagoTxt) {
    doc.fillColor(GRIS).fontSize(8).font('Helvetica-Bold').text('FORMA DE PAGO', left, y)
    doc.fillColor(TINTA).fontSize(10).font('Helvetica').text(pagoTxt, left, y + 12)
    y += 34
  }
  if (pago.descripcion) {
    doc.fillColor(GRIS).fontSize(8).font('Helvetica-Bold').text('OBSERVACIONES', left, y)
    doc.fillColor(TINTA).fontSize(10).font('Helvetica').text(pago.descripcion, left, y + 12, { width })
    y += 12 + doc.heightOfString(pago.descripcion, { width }) + 16
  }

  // ── Conformidad y firmas ────────────────────────────────────
  y = Math.max(y + 24, 560)
  doc.fillColor(TINTA).fontSize(9).font('Helvetica')
     .text(`Recibí de ${B.EMPRESA.razon} la suma de ${money(c.neto)} en concepto de ${esSueldo ? 'sueldo' : (TIPO_LABEL[pago.tipo] || 'pago').toLowerCase()}, sin nada más que reclamar por dicho concepto.`, left, y, { width })
  y += 80
  const wFirma = width / 2 - 30
  doc.moveTo(left, y).lineTo(left + wFirma, y).strokeColor(TINTA).lineWidth(0.8).stroke()
  doc.moveTo(right - wFirma, y).lineTo(right, y).stroke()
  doc.fillColor(GRIS).fontSize(8.5)
     .text('Firma del empleador', left, y + 5, { width: wFirma, align: 'center' })
     .text('Firma y aclaración del empleado', right - wFirma, y + 5, { width: wFirma, align: 'center' })
  doc.fillColor(GRIS).fontSize(8).text(nombre, right - wFirma, y + 17, { width: wFirma, align: 'center' })

  B.drawFooter(doc, { extra: numeroRecibo(pago) })
}

function generarReciboPDF(res, pago) {
  const doc = new PDFDocument({ size: 'A4', margin: 40 })
  res.setHeader('Content-Type', 'application/pdf')
  res.setHeader('Content-Disposition', `inline; filename="recibo-${numeroRecibo(pago)}.pdf"`)
  doc.pipe(res)
  construirRecibo(doc, pago)
  doc.end()
}

module.exports = { generarReciboPDF, numeroRecibo, periodoLegible, conceptos }
