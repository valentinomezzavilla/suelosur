'use strict'
// ─────────────────────────────────────────────────────────────────
// pdfLiquidacion.js — Liquidación para compartir con el cliente: ficha, resumen,
// cada operación con su detalle y estado de pago, resumen por obra y pagos.
// Sin cliente ("Liquidación general"): resumen por cliente y cada cliente en página nueva.
// ─────────────────────────────────────────────────────────────────
const PDFDocument = require('pdfkit')
const B = require('./pdfBrand')
const { fmtFecha, hoyISO } = require('./fecha')
const { nroLiquidacion, ESTADOS } = require('./liquidaciones')

const LEYENDA = 'Los pagos se imputan a las operaciones más antiguas. Ante cualquier diferencia, comuníquese con administración.'
const COLOR_ESTADO = { pagada: B.VERDE, parcial: B.NARANJA, pendiente: B.ROJO, a_convenir: B.GRIS }
const PIE = 34 // alto reservado para el pie de página

const slug = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')

function nombreArchivoLiquidacion(liquidacion, filtros) {
  const quien = filtros.clienteId && liquidacion.clientes[0] ? slug(liquidacion.clientes[0].cliente.nombreCompleto) : 'general'
  return `liquidacion-${quien}-${filtros.desde}-${filtros.hasta}`
}

function generarLiquidacionPDF(res, { liquidacion, filtros, general }) {
  const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true })
  res.setHeader('Content-Type', 'application/pdf')
  res.setHeader('Content-Disposition', `inline; filename="${nombreArchivoLiquidacion(liquidacion, filtros)}.pdf"`)
  doc.pipe(res)

  const left = doc.page.margins.left
  const right = doc.page.width - doc.page.margins.right
  const width = right - left
  const limite = () => doc.page.height - doc.page.margins.bottom - PIE
  const hoy = hoyISO()
  const periodo = `${fmtFecha(filtros.desde)} al ${fmtFecha(filtros.hasta)}`
  let y

  const encabezado = (titulo) => {
    const derecha = [
      { label: 'N°', valor: nroLiquidacion(hoy, general ? null : filtros.clienteId), bold: true, color: B.TINTA },
      { label: 'Período', valor: periodo },
      { label: 'Emitida', valor: fmtFecha(hoy) },
    ]
    if (liquidacion.obra) derecha.push({ label: 'Obra', valor: liquidacion.obra, color: B.TINTA })
    y = B.drawHeader(doc, { titulo, derecha })
  }
  const nuevaPagina = (titulo) => { doc.addPage(); encabezado(titulo) }
  const asegurar = (alto, titulo) => { if (y + alto > limite()) nuevaPagina(titulo) }

  // ── Bloques ────────────────────────────────────────────────────
  function ficha(c) {
    doc.fillColor(B.GRIS).fontSize(8).font('Helvetica-Bold').text('CLIENTE', left, y)
    doc.fillColor(B.TINTA).fontSize(14).font('Helvetica-Bold').text(c.nombreCompleto, left, y + 11, { width })
    const datos = [c.numero != null && `Cliente N° ${c.numero}`, c.dni && `DNI ${c.dni}`, c.telefono && `Tel. ${c.telefono}`,
      c.direccion, c.email].filter(Boolean).join('   ·   ')
    doc.fillColor(B.GRIS).fontSize(8.5).font('Helvetica').text(datos || ' ', left, y + 30, { width })
    y += 48
  }

  function tarjetasResumen(r) {
    const cajas = [
      { label: 'TOTAL CONSUMIDO', valor: B.money(r.consumido), color: B.TINTA },
      { label: 'PAGADO', valor: B.money(r.pagado), color: B.VERDE },
      { label: 'SALDO PENDIENTE', valor: B.money(r.saldo), color: r.saldo > 0.005 ? B.ROJO : B.VERDE },
    ]
    const gap = 10, w = (width - gap * 2) / 3, h = 46
    cajas.forEach((c, i) => {
      const x = left + i * (w + gap)
      doc.roundedRect(x, y, w, h, 4).fillAndStroke(B.FONDO, B.LINEA)
      doc.fillColor(B.GRIS).fontSize(7.5).font('Helvetica-Bold').text(c.label, x + 10, y + 9, { width: w - 20 })
      doc.fillColor(c.color).fontSize(15).font('Helvetica-Bold').text(c.valor, x + 10, y + 21, { width: w - 20 })
    })
    y += h + 8
    doc.fillColor(B.GRIS).fontSize(8).font('Helvetica')
       .text(`${r.cantidad} operación${r.cantidad === 1 ? '' : 'es'} en el período`, left, y)
    y += 18
  }

  // Columnas de la tabla de detalle
  const COLS = [
    { key: 'descripcion', header: 'Detalle', w: 0.46, align: 'left' },
    { key: 'cantidad', header: 'Cant.', w: 0.1, align: 'right' },
    { key: 'unidad', header: 'Unid.', w: 0.1, align: 'left' },
    { key: 'precio_unit', header: 'P. unit.', w: 0.16, align: 'right', money: true },
    { key: 'importe', header: 'Importe', w: 0.18, align: 'right', money: true },
  ]
  const valor = (c, r) => c.money ? B.money(r[c.key]) : c.key === 'cantidad' ? Number(r.cantidad).toLocaleString('es-AR') : String(r[c.key] ?? '')
  const altoRenglon = (r) => Math.max(14, doc.font('Helvetica').fontSize(8.5).heightOfString(r.descripcion, { width: COLS[0].w * width - 8 }) + 5)
  const altoOperacion = (o) => 24 + 16 + o.renglones.reduce((s, r) => s + altoRenglon(r), 0) + 34

  function operacion(o, tituloPagina) {
    // Una operación no se corta entre páginas, salvo que no entre en una página entera
    const alto = altoOperacion(o)
    if (alto < limite() - 120) asegurar(alto, tituloPagina)

    // Barra de título
    doc.rect(left, y, width, 22).fill(B.AZUL)
    const titulo = [`OP-${String(o.nro_op).padStart(4, '0')}`, o.nro_remito && `Remito ${o.nro_remito}`, fmtFecha(o.fecha), o.tipoTexto,
      o.obra && `Obra: ${o.obra}`].filter(Boolean).join('  ·  ')
    doc.fillColor('#ffffff').fontSize(8.5).font('Helvetica-Bold').text(titulo, left + 8, y + 7, { width: width - 110, lineBreak: false, ellipsis: true })
    const etiqueta = ESTADOS[o.estado].toUpperCase()
    doc.roundedRect(right - 96, y + 4, 90, 14, 7).fill('#ffffff')
    doc.fillColor(COLOR_ESTADO[o.estado]).fontSize(7).font('Helvetica-Bold').text(etiqueta, right - 96, y + 8, { width: 90, align: 'center' })
    y += 24

    // Encabezado de la tabla
    doc.rect(left, y, width, 15).fill(B.FONDO)
    let x = left
    doc.fillColor(B.GRIS).fontSize(7).font('Helvetica-Bold')
    COLS.forEach(c => { doc.text(c.header.toUpperCase(), x + 4, y + 4, { width: c.w * width - 8, align: c.align }); x += c.w * width })
    y += 16

    // Renglones
    o.renglones.forEach(r => {
      const h = altoRenglon(r)
      if (y + h > limite()) { nuevaPagina(tituloPagina) }
      x = left
      doc.fillColor(B.TINTA).fontSize(8.5).font('Helvetica')
      COLS.forEach(c => { doc.text(valor(c, r), x + 4, y + 3, { width: c.w * width - 8, align: c.align }); x += c.w * width })
      y += h
      doc.moveTo(left, y).lineTo(right, y).strokeColor(B.LINEA).lineWidth(0.5).stroke()
    })

    // Pie de la operación
    y += 5
    const pie = o.estado === 'a_convenir'
      ? [['Precio a convenir', '', B.GRIS]]
      : [['Total', B.money(o.total), B.TINTA], ['Pagado', B.money(o.pagado), B.VERDE], ['Resta', B.money(o.resta), o.resta > 0.005 ? B.ROJO : B.VERDE]]
    doc.fontSize(8.5).font('Helvetica').fillColor(B.GRIS).text(`Pago: ${o.metodoTexto}`, left + 4, y + 2, { width: width * 0.4 })
    let xp = right
    pie.slice().reverse().forEach(([label, monto, color]) => {
      const txt = monto ? `${label}: ${monto}` : label
      const w = doc.font('Helvetica-Bold').widthOfString(txt) + 16
      xp -= w
      doc.fillColor(color).font('Helvetica-Bold').text(txt, xp, y + 2, { width: w, align: 'right' })
    })
    y += 26
  }

  function tablaSimple(titulo, columnas, filas, tituloPagina) {
    asegurar(40 + Math.min(filas.length, 3) * 15, tituloPagina)
    doc.fillColor(B.AZUL).fontSize(10).font('Helvetica-Bold').text(titulo.toUpperCase(), left, y)
    y += 16
    const cabecera = () => {
      doc.rect(left, y, width, 15).fill(B.FONDO)
      let x = left
      doc.fillColor(B.GRIS).fontSize(7).font('Helvetica-Bold')
      columnas.forEach(c => { doc.text(c.header.toUpperCase(), x + 4, y + 4, { width: c.w * width - 8, align: c.align }); x += c.w * width })
      y += 16
    }
    cabecera()
    filas.forEach(f => {
      if (y + 15 > limite()) { nuevaPagina(tituloPagina); cabecera() }
      let x = left
      doc.fillColor(f._color || B.TINTA).fontSize(8.5).font(f._bold ? 'Helvetica-Bold' : 'Helvetica')
      columnas.forEach(c => { doc.text(String(f[c.key] ?? ''), x + 4, y + 3, { width: c.w * width - 8, align: c.align, lineBreak: false, ellipsis: true }); x += c.w * width })
      y += 15
      doc.moveTo(left, y).lineTo(right, y).strokeColor(B.LINEA).lineWidth(0.5).stroke()
    })
    y += 14
  }

  function resumenPorObra(porObra, tituloPagina) {
    if (!porObra || !porObra.length) return
    tablaSimple('Resumen por obra', [
      { key: 'nombre', header: 'Obra', w: 0.4, align: 'left' }, { key: 'cantidad', header: 'Ops.', w: 0.09, align: 'right' },
      { key: 'consumido', header: 'Consumido', w: 0.17, align: 'right' }, { key: 'pagado', header: 'Pagado', w: 0.17, align: 'right' },
      { key: 'saldo', header: 'Saldo', w: 0.17, align: 'right' },
    ], porObra.map(o => ({ nombre: o.nombre, cantidad: o.resumen.cantidad, consumido: B.money(o.resumen.consumido),
      pagado: B.money(o.resumen.pagado), saldo: B.money(o.resumen.saldo) })), tituloPagina)
  }

  function pagos(lista, tituloPagina) {
    if (!lista) return
    const total = lista.reduce((s, p) => s + p.monto, 0)
    tablaSimple('Pagos recibidos del período', [
      { key: 'fecha', header: 'Fecha', w: 0.14, align: 'left' }, { key: 'metodo', header: 'Método', w: 0.18, align: 'left' },
      { key: 'descripcion', header: 'Descripción', w: 0.48, align: 'left' }, { key: 'monto', header: 'Monto', w: 0.2, align: 'right' },
    ], [
      ...lista.map(p => ({ fecha: fmtFecha(p.fecha), metodo: p.metodoTexto, descripcion: p.descripcion, monto: B.money(p.monto) })),
      ...(lista.length ? [] : [{ descripcion: 'Sin pagos registrados en el período', _color: B.GRIS }]),
      { descripcion: 'TOTAL', monto: B.money(total), _bold: true },
    ], tituloPagina)
  }

  function operaciones(c, tituloPagina) {
    if (!c.operaciones.length) {
      doc.fillColor(B.GRIS).fontSize(10).font('Helvetica').text('Sin operaciones en el período.', left, y, { width, align: 'center' })
      y += 26
      return
    }
    doc.fillColor(B.AZUL).fontSize(10).font('Helvetica-Bold').text('DETALLE DE OPERACIONES', left, y)
    y += 16
    c.operaciones.forEach(o => operacion(o, tituloPagina))
  }

  // ── Armado ─────────────────────────────────────────────────────
  if (general) {
    const titulo = 'Liquidación general'
    encabezado(titulo)
    tarjetasResumen(liquidacion.resumen)
    tablaSimple('Resumen por cliente', [
      { key: 'nombre', header: 'Cliente', w: 0.4, align: 'left' }, { key: 'cantidad', header: 'Ops.', w: 0.09, align: 'right' },
      { key: 'consumido', header: 'Consumido', w: 0.17, align: 'right' }, { key: 'pagado', header: 'Pagado', w: 0.17, align: 'right' },
      { key: 'saldo', header: 'Saldo', w: 0.17, align: 'right' },
    ], liquidacion.clientes.map(c => ({ nombre: c.cliente.nombreCompleto, cantidad: c.resumen.cantidad, consumido: B.money(c.resumen.consumido),
      pagado: B.money(c.resumen.pagado), saldo: B.money(c.resumen.saldo) })), titulo)
    if (!liquidacion.clientes.length) {
      doc.fillColor(B.GRIS).fontSize(10).font('Helvetica').text('Sin operaciones en el período.', left, y, { width, align: 'center' })
    }
    liquidacion.clientes.forEach(c => {
      nuevaPagina(titulo)
      ficha(c.cliente)
      tarjetasResumen(c.resumen)
      operaciones(c, titulo)
    })
  } else {
    const titulo = 'Liquidación'
    const c = liquidacion.clientes[0]
    encabezado(titulo)
    ficha(c.cliente)
    tarjetasResumen(c.resumen)
    operaciones(c, titulo)
    resumenPorObra(c.porObra, titulo)
    pagos(c.pagos, titulo)
  }

  // ── Pie en todas las páginas: leyenda, página X de Y ─────────
  const rango = doc.bufferedPageRange()
  for (let i = 0; i < rango.count; i++) {
    doc.switchToPage(rango.start + i)
    const yPie = doc.page.height - doc.page.margins.bottom - PIE + 8
    doc.moveTo(left, yPie - 4).lineTo(right, yPie - 4).strokeColor(B.LINEA).lineWidth(0.5).stroke()
    doc.fillColor(B.GRIS).fontSize(7).font('Helvetica')
       .text(LEYENDA, left, yPie, { width: width - 90, lineBreak: false, ellipsis: true })
       .text(`Página ${i + 1} de ${rango.count}`, right - 90, yPie, { width: 90, align: 'right', lineBreak: false })
       .text(`Emitida el ${fmtFecha(hoy)} · ${B.EMPRESA.razon}`, left, yPie + 11, { width, lineBreak: false })
  }
  doc.end()
}

module.exports = { generarLiquidacionPDF, nombreArchivoLiquidacion }
