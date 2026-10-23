'use strict'
// ─────────────────────────────────────────────────────────────────
// pdfFacturacion.js — Detalle de facturación de una o varias operaciones de un cliente:
// datos fiscales, cada operación con su detalle (neto) y el total con neto, IVA y total.
//  - Pendiente de facturar: "Detalle para facturar" (no es un comprobante fiscal).
//  - Facturada: los datos del comprobante registrado (tipo, número, fecha, CAE). No reemplaza
//    al comprobante fiscal.
// Mismo diseño que la liquidación: blanco, negro y grises, filetes finos.
// ─────────────────────────────────────────────────────────────────
const PDFDocument = require('pdfkit')
const B = require('./pdfBrand')
const { fmtFecha, hoyISO } = require('./fecha')

const NEGRO = '#111111'
const GRIS = '#555555'
const LINEA = '#c8c8c8'
const BANDA = '#efefef'
const PIE = 34

const nroOp = (n) => 'OP-' + String(n).padStart(4, '0')
const slug = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')

function nombreArchivoFacturacion({ cliente, comprobante }) {
  const quien = slug(cliente.razonSocial || cliente.nombre) || 'cliente'
  return comprobante
    ? `factura-${slug(`${comprobante.tipo} ${comprobante.numero}`)}-${quien}`
    : `detalle-facturar-${quien}-${hoyISO()}`
}

// datos:
//  cliente: { nombre, razonSocial, cuit, dni, condicion, domicilio }
//  operaciones: [{ nro_op, nro_remito, fecha, tipoTexto, obra, renglones: [{ descripcion, cantidad, unidad, precio_unit, importe }], neto }]
//  totales: { neto, iva, total, alicuota }
//  comprobante: null (pendiente) | { tipo, numero, fecha, cae, caeVto, origen }
//  ivaIncluido: true si alguna operación se cargó con el IVA ya incluido en sus importes
//  empresa: { cuit, condicion } (de la configuración de facturación)
function generarFacturacionPDF(res, { cliente, operaciones, totales, comprobante = null, ivaIncluido = false, empresa = {} }) {
  const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true })
  res.setHeader('Content-Type', 'application/pdf')
  res.setHeader('Content-Disposition', `inline; filename="${nombreArchivoFacturacion({ cliente, comprobante })}.pdf"`)
  doc.pipe(res)

  const left = doc.page.margins.left
  const right = doc.page.width - doc.page.margins.right
  const width = right - left
  const limite = () => doc.page.height - doc.page.margins.bottom - PIE
  const hoy = hoyISO()
  // No es el comprobante fiscal (ese lo emite AFIP o el talonario): es el detalle de sus importes
  const titulo = comprobante ? `Detalle de factura ${comprobante.tipo}` : 'Detalle para facturar'
  let y

  const linea = (yy, grosor = 0.5, color = LINEA) =>
    doc.moveTo(left, yy).lineTo(right, yy).lineWidth(grosor).strokeColor(color).stroke()

  const encabezado = () => {
    const top = doc.page.margins.top
    let textoX = left
    if (B.HAY_LOGO) {
      try { doc.image(B.LOGO_PATH, left, top, { width: 40, height: 40 }); textoX = left + 52 } catch (_) { /* sin logo */ }
    }
    const izqAncho = width / 2 - (textoX - left) - 8
    doc.fillColor(NEGRO).font('Helvetica-Bold').fontSize(13).text(B.EMPRESA.razon.toUpperCase(), textoX, top + 3, { width: izqAncho, lineBreak: false })
    const datosEmpresa = [B.EMPRESA.rubro, B.EMPRESA.lugar]
    if (empresa.cuit) datosEmpresa.push(`CUIT ${empresa.cuit}${empresa.condicion ? ' · ' + empresa.condicion : ''}`)
    doc.fillColor(GRIS).font('Helvetica').fontSize(8)
    datosEmpresa.forEach((t, i) => doc.text(t, textoX, top + 20 + i * 11, { width: izqAncho, lineBreak: false }))

    // El lado derecho usa solo su mitad: no puede montarse sobre los datos de la empresa
    const derX = left + width / 2, derAncho = width / 2
    doc.fillColor(NEGRO).font('Helvetica-Bold').fontSize(14).text(titulo.toUpperCase(), derX, top + 3, { width: derAncho, align: 'right', lineBreak: false })
    const lineas = comprobante
      ? [`N° ${comprobante.numero}`, `Fecha: ${fmtFecha(comprobante.fecha)}`]
      : [`Fecha: ${fmtFecha(hoy)}`]
    if (comprobante?.cae) lineas.push(`CAE ${comprobante.cae}${comprobante.caeVto ? ' · Vto. ' + fmtFecha(comprobante.caeVto) : ''}`)
    let yd = top + 22
    lineas.forEach((t, i) => {
      doc.fillColor(i === 0 ? NEGRO : GRIS).font(i === 0 ? 'Helvetica-Bold' : 'Helvetica').fontSize(8)
         .text(t, derX, yd, { width: derAncho, align: 'right', lineBreak: false })
      yd += 11
    })
    const yFin = Math.max(top + 20 + datosEmpresa.length * 11, yd) + 2
    linea(yFin, 1.2, NEGRO)
    y = yFin + 14
  }
  const nuevaPagina = () => { doc.addPage(); encabezado() }
  const asegurar = (alto) => { if (y + alto > limite()) nuevaPagina() }

  function seccion(texto) {
    doc.fillColor(NEGRO).fontSize(9).font('Helvetica-Bold').text(texto.toUpperCase(), left, y, { lineBreak: false })
    y += 14
    linea(y, 0.8, NEGRO)
    y += 8
  }

  // Datos del cliente (receptor), en dos columnas. Cada dato ocupa lo que mide su texto:
  // una razón social o un domicilio largos pasan a otra línea sin pisar el dato de abajo.
  function ficha() {
    const columna = (filas, x, ancho) => {
      let yy = y
      filas.forEach(([label, valor], i) => {
        const fuerte = x === left && i === 0
        const fuente = fuerte ? 'Helvetica-Bold' : 'Helvetica'
        const tam = fuerte ? 10 : 9
        const alto = doc.font(fuente).fontSize(tam).heightOfString(valor, { width: ancho - 74 })
        doc.fillColor(GRIS).font('Helvetica').fontSize(8).text(label, x, yy + 1, { width: 70, lineBreak: false })
        doc.fillColor(NEGRO).font(fuente).fontSize(tam).text(valor, x + 74, yy, { width: ancho - 74 })
        yy += Math.max(15, alto + 4)
      })
      return yy
    }
    const mitad = width / 2
    const izq = [['Cliente', cliente.razonSocial || cliente.nombre]]
    if (cliente.razonSocial && cliente.razonSocial !== cliente.nombre) izq.push(['Contacto', cliente.nombre])
    if (cliente.cuit) izq.push(['CUIT', String(cliente.cuit)])
    else if (cliente.dni) izq.push(['DNI', String(cliente.dni)])
    const der = [['Condición IVA', cliente.condicion || 'Sin cargar']]
    if (cliente.domicilio) der.push(['Domicilio', String(cliente.domicilio)])
    y = Math.max(columna(izq, left, mitad - 12), columna(der, left + mitad, mitad)) + 6
    linea(y)
    y += 14
  }

  const COLS = [
    { key: 'descripcion', header: 'Detalle', w: 0.46, align: 'left' },
    { key: 'cantidad', header: 'Cant.', w: 0.1, align: 'right' },
    { key: 'unidad', header: 'Unid.', w: 0.1, align: 'left' },
    { key: 'precio_unit', header: 'P. unit.', w: 0.16, align: 'right', money: true },
    { key: 'importe', header: 'Importe', w: 0.18, align: 'right', money: true },
  ]
  const valor = (c, r) => c.money ? B.money(r[c.key]) : c.key === 'cantidad' ? Number(r.cantidad).toLocaleString('es-AR') : String(r[c.key] ?? '')
  const altoRenglon = (r) => Math.max(15, doc.font('Helvetica').fontSize(8.5).heightOfString(r.descripcion, { width: COLS[0].w * width - 8 }) + 6)
  const tituloOperacion = (o) => [o.nro_remito ? `Remito ${o.nro_remito}` : nroOp(o.nro_op), o.nro_remito && nroOp(o.nro_op),
    fmtFecha(o.fecha), o.tipoTexto, o.obra && `Obra: ${o.obra}`].filter(Boolean).join('  ·  ')
  const altoFranja = (o) => Math.max(20, doc.font('Helvetica-Bold').fontSize(8.5).heightOfString(tituloOperacion(o), { width: width - 140 }) + 11)

  function operacion(o) {
    const alto = altoFranja(o) + 19 + o.renglones.reduce((s, r) => s + altoRenglon(r), 0) + 14
    if (alto < limite() - 120) asegurar(alto)
    const franja = altoFranja(o)
    doc.rect(left, y, width, franja).fill(BANDA)
    doc.fillColor(NEGRO).fontSize(8.5).font('Helvetica-Bold').text(tituloOperacion(o), left + 8, y + 6, { width: width - 140 })
    doc.fillColor(NEGRO).fontSize(8.5).font('Helvetica-Bold').text(B.money(o.neto), right - 124, y + 6, { width: 116, align: 'right', lineBreak: false })
    y += franja

    let x = left
    doc.fillColor(GRIS).fontSize(7).font('Helvetica-Bold')
    COLS.forEach(c => { doc.text(c.header.toUpperCase(), x + 4, y + 5, { width: c.w * width - 8, align: c.align, lineBreak: false }); x += c.w * width })
    y += 17
    linea(y, 0.8, NEGRO)
    o.renglones.forEach(r => {
      const h = altoRenglon(r)
      if (y + h > limite()) nuevaPagina()
      x = left
      doc.fillColor(NEGRO).fontSize(8.5).font('Helvetica')
      COLS.forEach(c => { doc.text(valor(c, r), x + 4, y + 4, { width: c.w * width - 8, align: c.align }); x += c.w * width })
      y += h
      linea(y)
    })
    y += 14
  }

  // Totales: neto, IVA y total, alineados a la derecha
  function cajaTotales() {
    const filas = [
      { label: 'Subtotal neto', valor: B.money(totales.neto) },
      { label: `IVA ${String(totales.alicuota).replace('.', ',')}%`, valor: B.money(totales.iva) },
    ]
    const alto = filas.length * 18 + 34
    asegurar(alto + (ivaIncluido ? 20 : 0))
    const w = 250, x = right - w
    filas.forEach(f => {
      doc.fillColor(GRIS).fontSize(9).font('Helvetica').text(f.label, x, y, { width: w - 120, lineBreak: false })
      doc.fillColor(NEGRO).fontSize(9).font('Helvetica').text(f.valor, x + w - 120, y, { width: 120, align: 'right', lineBreak: false })
      y += 18
    })
    doc.moveTo(x, y - 4).lineTo(right, y - 4).lineWidth(1).strokeColor(NEGRO).stroke()
    doc.fillColor(NEGRO).fontSize(11).font('Helvetica-Bold').text('TOTAL', x, y + 4, { width: w - 140, lineBreak: false })
    doc.fontSize(14).text(B.money(totales.total), x + w - 160, y + 2, { width: 160, align: 'right', lineBreak: false })
    y += 30
    if (ivaIncluido) {
      doc.fillColor(GRIS).fontSize(7.5).font('Helvetica')
         .text('Hay operaciones cargadas con el IVA incluido en su precio: su detalle figura con IVA y el neto se calculó desde el total.', left, y, { width })
      y += 20
    }
  }

  // ── Armado ─────────────────────────────────────────────────────
  encabezado()
  ficha()
  seccion(`Detalle de ${operaciones.length === 1 ? 'la operación' : `las ${operaciones.length} operaciones`}`)
  if (!operaciones.length) {
    doc.fillColor(GRIS).fontSize(10).font('Helvetica').text('Sin operaciones.', left, y, { width, align: 'center' })
    y += 26
  }
  operaciones.forEach(operacion)
  cajaTotales()

  const rango = doc.bufferedPageRange()
  for (let i = 0; i < rango.count; i++) {
    doc.switchToPage(rango.start + i)
    const yPie = doc.page.height - doc.page.margins.bottom - PIE + 8
    linea(yPie - 4)
    doc.fillColor(GRIS).fontSize(7).font('Helvetica')
       .text(comprobante ? 'Detalle de los importes facturados. No reemplaza al comprobante fiscal.' : 'Detalle de los importes a facturar. No válido como factura.', left, yPie, { width: width - 90, lineBreak: false })
       .text(`Página ${i + 1} de ${rango.count}`, right - 90, yPie, { width: 90, align: 'right', lineBreak: false })
       .text(`${B.EMPRESA.razon} · Emitido el ${fmtFecha(hoy)}`, left, yPie + 11, { width, lineBreak: false })
    B.drawDesarrolladoPor(doc)
  }
  doc.end()
}

module.exports = { generarFacturacionPDF, nombreArchivoFacturacion }
