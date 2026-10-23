'use strict'
// ─────────────────────────────────────────────────────────────────
// pdfLiquidacion.js — Liquidación para compartir con el cliente: ficha, resumen,
// cada operación con su detalle y estado, resumen por obra y saldo pendiente (sin el listado de pagos).
// Sin cliente ("Liquidación general"): resumen por cliente y cada cliente en página nueva.
// Diseño formal y sobrio: blanco, negro y grises, filetes finos, sin colores de acento.
// No muestra el método de pago de cada operación: todo lo que figura se liquida junto.
// Con el filtro "Solo pendientes" muestra solo lo que se debe: sin lo pagado.
// ─────────────────────────────────────────────────────────────────
const PDFDocument = require('pdfkit')
const B = require('./pdfBrand')
const { fmtFecha, hoyISO } = require('./fecha')
const { nroLiquidacion, ESTADOS } = require('./liquidaciones')

const LEYENDA = 'Los pagos se imputan a las operaciones más antiguas. Ante cualquier diferencia, comuníquese con administración.'
const NEGRO = '#111111'
const GRIS = '#555555'
const LINEA = '#c8c8c8'
const BANDA = '#efefef'
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
  const soloPendiente = filtros.estadoPago === 'pendientes'
  const periodo = `${fmtFecha(filtros.desde)} al ${fmtFecha(filtros.hasta)}`
  let y

  const linea = (yy, grosor = 0.5, color = LINEA) =>
    doc.moveTo(left, yy).lineTo(right, yy).lineWidth(grosor).strokeColor(color).stroke()

  // Encabezado: empresa a la izquierda; título, número y período a la derecha
  const encabezado = (titulo) => {
    const top = doc.page.margins.top
    let textoX = left
    if (B.HAY_LOGO) {
      try { doc.image(B.LOGO_PATH, left, top, { width: 40, height: 40 }); textoX = left + 52 } catch (_) { /* sin logo */ }
    }
    doc.fillColor(NEGRO).font('Helvetica-Bold').fontSize(13).text(B.EMPRESA.razon.toUpperCase(), textoX, top + 3, { lineBreak: false })
    doc.fillColor(GRIS).font('Helvetica').fontSize(8)
       .text(B.EMPRESA.rubro, textoX, top + 20, { lineBreak: false })
       .text(B.EMPRESA.lugar, textoX, top + 31, { lineBreak: false })

    doc.fillColor(NEGRO).font('Helvetica-Bold').fontSize(14).text(titulo.toUpperCase(), left, top + 3, { width, align: 'right', lineBreak: false })
    const lineas = [
      `N° ${nroLiquidacion(hoy, general ? null : filtros.clienteId)}`,
      `Período: ${periodo}`,
      `Fecha de emisión: ${fmtFecha(hoy)}`,
    ]
    if (liquidacion.obra) lineas.push(`Obra: ${liquidacion.obra}`)
    let yd = top + 22
    lineas.forEach((t, i) => {
      doc.fillColor(i === 0 ? NEGRO : GRIS).font(i === 0 ? 'Helvetica-Bold' : 'Helvetica').fontSize(8)
         .text(t, left, yd, { width, align: 'right', lineBreak: false })
      yd += 11
    })
    const yFin = Math.max(top + 46, yd) + 2
    linea(yFin, 1.2, NEGRO)
    y = yFin + 14
  }
  const nuevaPagina = (titulo) => { doc.addPage(); encabezado(titulo) }
  const asegurar = (alto, titulo) => { if (y + alto > limite()) nuevaPagina(titulo) }

  // ── Bloques ────────────────────────────────────────────────────
  // Ficha del cliente en dos columnas. Cada dato ocupa lo que mide su texto: un nombre,
  // domicilio o e-mail largos pasan a otra línea sin pisar el dato de abajo ni la otra columna.
  function ficha(c) {
    const columna = (filas, x, ancho) => {
      let yy = y
      filas.forEach(([label, valor], i) => {
        const fuerte = x === left && i === 0
        const fuente = fuerte ? 'Helvetica-Bold' : 'Helvetica'
        const tam = fuerte ? 10 : 9
        const alto = doc.font(fuente).fontSize(tam).heightOfString(valor, { width: ancho - 66 })
        doc.fillColor(GRIS).font('Helvetica').fontSize(8).text(label, x, yy + 1, { width: 62, lineBreak: false })
        doc.fillColor(NEGRO).font(fuente).fontSize(tam).text(valor, x + 66, yy, { width: ancho - 66 })
        yy += Math.max(15, alto + 4)
      })
      return yy
    }
    const mitad = width / 2
    const izq = [['Cliente', c.nombreCompleto]]
    if (c.numero != null) izq.push(['N° de cliente', String(c.numero)])
    if (c.dni) izq.push(['DNI / CUIT', String(c.dni)])
    const der = []
    if (c.telefono) der.push(['Teléfono', String(c.telefono)])
    if (c.direccion) der.push(['Domicilio', String(c.direccion)])
    if (c.email) der.push(['E-mail', String(c.email)])
    // Sin datos de contacto el nombre usa todo el ancho
    y = Math.max(columna(izq, left, der.length ? mitad - 12 : width), columna(der, left + mitad, mitad)) + 6
    linea(y)
    y += 14
  }

  // Resumen: una franja con tres columnas separadas por filetes (solo pendientes: solo el saldo)
  function tarjetasResumen(r) {
    const cajas = [
      ...(soloPendiente ? [] : [
        { label: 'TOTAL CONSUMIDO', valor: B.money(r.consumido) },
        { label: 'PAGADO', valor: B.money(r.pagado) },
      ]),
      { label: 'SALDO PENDIENTE', valor: B.money(r.saldo), fuerte: true },
    ]
    const w = width / cajas.length, h = 44
    doc.rect(left, y, width, h).lineWidth(0.8).strokeColor(NEGRO).stroke()
    cajas.forEach((c, i) => {
      const x = left + i * w
      if (i > 0) doc.moveTo(x, y).lineTo(x, y + h).lineWidth(0.5).strokeColor(LINEA).stroke()
      doc.fillColor(GRIS).fontSize(7.5).font('Helvetica-Bold').text(c.label, x + 12, y + 9, { width: w - 24, lineBreak: false })
      doc.fillColor(NEGRO).fontSize(c.fuerte ? 15 : 13).font('Helvetica-Bold').text(c.valor, x + 12, y + 21, { width: w - 24, lineBreak: false })
    })
    y += h + 8
    doc.fillColor(GRIS).fontSize(8).font('Helvetica')
       .text(`${r.cantidad} ${r.cantidad === 1 ? 'operación' : 'operaciones'} ${soloPendiente ? 'con saldo pendiente' : 'en el período'}`, left, y, { lineBreak: false })
    y += 20
  }

  // Título de sección: texto en negrita con un filete negro debajo
  function seccion(texto) {
    doc.fillColor(NEGRO).fontSize(9).font('Helvetica-Bold').text(texto.toUpperCase(), left, y, { lineBreak: false })
    y += 14
    linea(y, 0.8, NEGRO)
    y += 8
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
  const altoRenglon = (r) => Math.max(15, doc.font('Helvetica').fontSize(8.5).heightOfString(r.descripcion, { width: COLS[0].w * width - 8 }) + 6)
  // El N° mostrado es el remito cargado en el campo Remito; el N° de OP (automático) solo si no hay remito
  const tituloOperacion = (o) => [o.nro_remito ? `Remito ${o.nro_remito}` : `OP-${String(o.nro_op).padStart(4, '0')}`, fmtFecha(o.fecha), o.tipoTexto,
    o.obra && `Obra: ${o.obra}`].filter(Boolean).join('  ·  ')
  // Alto de la franja gris: crece si el título (obra larga) ocupa más de una línea
  const altoFranja = (o) => Math.max(20, doc.font('Helvetica-Bold').fontSize(8.5).heightOfString(tituloOperacion(o), { width: width - 140 }) + 11)
  const altoOperacion = (o) => altoFranja(o) + 2 + 18 + o.renglones.reduce((s, r) => s + altoRenglon(r), 0) + 14

  function operacion(o, tituloPagina) {
    // Una operación no se corta entre páginas, salvo que no entre en una página entera
    const alto = altoOperacion(o)
    if (alto < limite() - 120) asegurar(alto, tituloPagina)

    // Franja gris con los datos de la operación y su estado (más alta si el título no entra en una línea)
    const franja = altoFranja(o)
    doc.rect(left, y, width, franja).fill(BANDA)
    doc.fillColor(NEGRO).fontSize(8.5).font('Helvetica-Bold').text(tituloOperacion(o), left + 8, y + 6, { width: width - 140 })
    doc.fillColor(NEGRO).fontSize(7.5).font('Helvetica-Bold').text(ESTADOS[o.estado].toUpperCase(), right - 124, y + 6.5, { width: 116, align: 'right', lineBreak: false })
    y += franja

    // Pago parcial: la última columna muestra lo que resta de cada renglón (en proporción a
    // lo que falta pagar de la operación) en vez del importe total
    const parcial = o.estado === 'parcial' && Number(o.total) > 0
    const cabecera = (c) => (parcial && c.key === 'importe' ? 'Resta' : c.header)
    const celda = (c, r) => (parcial && c.key === 'importe'
      ? B.money(Math.round(Number(r.importe) * Number(o.resta) / Number(o.total) * 100) / 100)
      : valor(c, r))

    // Encabezado de la tabla
    let x = left
    doc.fillColor(GRIS).fontSize(7).font('Helvetica-Bold')
    COLS.forEach(c => { doc.text(cabecera(c).toUpperCase(), x + 4, y + 5, { width: c.w * width - 8, align: c.align, lineBreak: false }); x += c.w * width })
    y += 17
    linea(y, 0.8, NEGRO)

    // Renglones
    o.renglones.forEach(r => {
      const h = altoRenglon(r)
      if (y + h > limite()) { nuevaPagina(tituloPagina) }
      x = left
      doc.fillColor(NEGRO).fontSize(8.5).font('Helvetica')
      COLS.forEach(c => { doc.text(celda(c, r), x + 4, y + 4, { width: c.w * width - 8, align: c.align }); x += c.w * width })
      y += h
      linea(y)
    })

    // Sin pie por operación (total/pagado/resta): los totales van en el resumen
    y += 14
  }

  function tablaSimple(titulo, columnas, filas, tituloPagina) {
    asegurar(50 + Math.min(filas.length, 3) * 15, tituloPagina)
    seccion(titulo)
    const cabecera = () => {
      let x = left
      doc.fillColor(GRIS).fontSize(7).font('Helvetica-Bold')
      columnas.forEach(c => { doc.text(c.header.toUpperCase(), x + 4, y + 1, { width: c.w * width - 8, align: c.align, lineBreak: false }); x += c.w * width })
      y += 12
      linea(y)
    }
    cabecera()
    filas.forEach(f => {
      doc.fontSize(8.5).font(f._bold ? 'Helvetica-Bold' : 'Helvetica')
      const h = Math.max(16, ...columnas.map(c => doc.heightOfString(String(f[c.key] ?? ''), { width: c.w * width - 8 }) + 7))
      if (y + h > limite()) { nuevaPagina(tituloPagina); cabecera() }
      if (f._bold) linea(y, 0.8, NEGRO)
      let x = left
      doc.fillColor(f._color || NEGRO).fontSize(8.5).font(f._bold ? 'Helvetica-Bold' : 'Helvetica')
      columnas.forEach(c => { doc.text(String(f[c.key] ?? ''), x + 4, y + 4, { width: c.w * width - 8, align: c.align }); x += c.w * width })
      y += h
      linea(y, f._bold ? 0.8 : 0.5, f._bold ? NEGRO : LINEA)
    })
    y += 16
  }

  // Resumen por obra o por cliente: consumido / pagado / saldo (solo pendientes: solo el saldo)
  function tablaResumen(titulo, encabezado, filas, tituloPagina) {
    const columnas = soloPendiente
      ? [{ key: 'nombre', header: encabezado, w: 0.62, align: 'left' }, { key: 'cantidad', header: 'Ops.', w: 0.12, align: 'right' },
         { key: 'saldo', header: 'Saldo', w: 0.26, align: 'right' }]
      : [{ key: 'nombre', header: encabezado, w: 0.4, align: 'left' }, { key: 'cantidad', header: 'Ops.', w: 0.09, align: 'right' },
         { key: 'consumido', header: 'Consumido', w: 0.17, align: 'right' }, { key: 'pagado', header: 'Pagado', w: 0.17, align: 'right' },
         { key: 'saldo', header: 'Saldo', w: 0.17, align: 'right' }]
    tablaSimple(titulo, columnas, filas.map(f => ({ nombre: f.nombre, cantidad: f.resumen.cantidad, consumido: B.money(f.resumen.consumido),
      pagado: B.money(f.resumen.pagado), saldo: B.money(f.resumen.saldo) })), tituloPagina)
  }

  function resumenPorObra(porObra, tituloPagina) {
    if (!porObra || !porObra.length) return
    tablaResumen('Resumen por obra', 'Obra', porObra, tituloPagina)
  }

  // Operaciones del período que todavía deben algo (las "a convenir" no tienen precio)
  function pendiente(ops, tituloPagina) {
    if (!ops) return
    const deben = ops.filter(o => o.estado !== 'a_convenir' && o.resta > 0)
    const total = deben.reduce((s, o) => s + o.resta, 0)
    const columnas = soloPendiente
      ? [{ key: 'nro', header: 'Remito / OP', w: 0.18, align: 'left' }, { key: 'fecha', header: 'Fecha', w: 0.14, align: 'left' },
         { key: 'obra', header: 'Obra', w: 0.44, align: 'left' }, { key: 'resta', header: 'Pendiente', w: 0.24, align: 'right' }]
      : [{ key: 'nro', header: 'Remito / OP', w: 0.14, align: 'left' }, { key: 'fecha', header: 'Fecha', w: 0.11, align: 'left' },
         { key: 'obra', header: 'Obra', w: 0.27, align: 'left' }, { key: 'total', header: 'Total', w: 0.16, align: 'right' },
         { key: 'pagado', header: 'Pagado', w: 0.16, align: 'right' }, { key: 'resta', header: 'Resta', w: 0.16, align: 'right' }]
    tablaSimple('Saldo pendiente', columnas, [
      ...deben.map(o => ({ nro: o.nro_remito ? `Remito ${o.nro_remito}` : `OP-${String(o.nro_op).padStart(4, '0')}`, fecha: fmtFecha(o.fecha),
        obra: o.obra || '', total: B.money(o.total), pagado: B.money(o.pagado), resta: B.money(o.resta) })),
      ...(deben.length ? [] : [{ obra: 'Sin saldo pendiente en el período', _color: GRIS }]),
      { obra: 'TOTAL PENDIENTE', resta: B.money(total), _bold: true },
    ], tituloPagina)
  }

  function operaciones(c, tituloPagina) {
    if (!c.operaciones.length) {
      doc.fillColor(GRIS).fontSize(10).font('Helvetica').text('Sin operaciones en el período.', left, y, { width, align: 'center' })
      y += 26
      return
    }
    seccion('Detalle de operaciones')
    c.operaciones.forEach(o => operacion(o, tituloPagina))
  }

  // ── Armado ─────────────────────────────────────────────────────
  if (general) {
    const titulo = 'Liquidación general'
    encabezado(titulo)
    tarjetasResumen(liquidacion.resumen)
    tablaResumen('Resumen por cliente', 'Cliente',
      liquidacion.clientes.map(c => ({ nombre: c.cliente.nombreCompleto, resumen: c.resumen })), titulo)
    if (!liquidacion.clientes.length) {
      doc.fillColor(GRIS).fontSize(10).font('Helvetica').text('Sin operaciones en el período.', left, y, { width, align: 'center' })
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
    pendiente(c.operaciones, titulo)
  }

  // ── Pie en todas las páginas: leyenda, página X de Y ─────────
  const rango = doc.bufferedPageRange()
  for (let i = 0; i < rango.count; i++) {
    doc.switchToPage(rango.start + i)
    const yPie = doc.page.height - doc.page.margins.bottom - PIE + 8
    linea(yPie - 4)
    doc.fillColor(GRIS).fontSize(7).font('Helvetica')
       .text(LEYENDA, left, yPie, { width: width - 90, lineBreak: false, ellipsis: true })
       .text(`Página ${i + 1} de ${rango.count}`, right - 90, yPie, { width: 90, align: 'right', lineBreak: false })
       .text(`${B.EMPRESA.razon} · Emitida el ${fmtFecha(hoy)}`, left, yPie + 11, { width, lineBreak: false })
    B.drawDesarrolladoPor(doc)
  }
  doc.end()
}

module.exports = { generarLiquidacionPDF, nombreArchivoLiquidacion }
