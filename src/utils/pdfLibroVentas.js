'use strict'
// ─────────────────────────────────────────────────────────────────
// pdfLibroVentas.js — Libro de ventas en PDF (apaisado).
// Columnas: Fecha · Remito · Cant. · Cód · Material · Cliente · Obra
//           · Precio unitario · Importe. Con total al pie.
// ─────────────────────────────────────────────────────────────────
const PDFDocument = require('pdfkit')
const { fmtFecha } = require('./fecha')
const B = require('./pdfBrand')

const PAD = 4

function generarLibroVentasPDF(res, { filas = [], total = 0, periodoLabel, clienteLabel, nombreArchivo } = {}) {
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 36 })
  res.setHeader('Content-Type', 'application/pdf')
  res.setHeader('Content-Disposition', `inline; filename="${nombreArchivo || 'libro-ventas'}.pdf"`)
  doc.pipe(res)

  const left = doc.page.margins.left
  const right = doc.page.width - doc.page.margins.right
  const width = right - left

  const derecha = [{ label: 'Período', valor: periodoLabel || 'Histórico completo' }]
  if (clienteLabel) derecha.unshift({ label: 'Cliente', valor: clienteLabel, color: B.TINTA, bold: true })
  let y = B.drawHeader(doc, { titulo: 'Libro de ventas', derecha })

  // Columnas (proporción del ancho disponible)
  const cols = [
    { key: 'fecha',       label: 'FECHA',    w: 0.09, align: 'left'  },
    { key: 'nro_remito',  label: 'REMITO',   w: 0.07, align: 'left'  },
    { key: 'cantidad',    label: 'CANT.',    w: 0.06, align: 'right' },
    { key: 'cod',         label: 'CÓD',      w: 0.05, align: 'left'  },
    { key: 'material',    label: 'MATERIAL', w: 0.15, align: 'left'  },
    { key: 'cliente',     label: 'CLIENTE',  w: 0.19, align: 'left'  },
    { key: 'obra',        label: 'OBRA',     w: 0.19, align: 'left'  },
    { key: 'precio_unit', label: 'P. UNIT.', w: 0.10, align: 'right' },
    { key: 'importe',     label: 'IMPORTE',  w: 0.10, align: 'right' },
  ]
  let acc = left
  cols.forEach(c => { c.x = acc; c.width = width * c.w; acc += c.width })

  const place = (c) => c.align === 'right'
    ? { x: c.x, w: c.width - PAD, align: 'right' }
    : { x: c.x + PAD, w: c.width - PAD * 2, align: 'left' }

  const drawHead = () => {
    doc.rect(left, y, width, 18).fill(B.FONDO)
    doc.fillColor(B.GRIS).fontSize(7.5).font('Helvetica-Bold')
    cols.forEach(c => { const p = place(c); doc.text(c.label, p.x, y + 5, { width: p.w, align: p.align, lineBreak: false }) })
    y += 18
  }
  drawHead()

  const cell = (c, val) => {
    const p = place(c)
    doc.text(val == null ? '' : String(val), p.x, y + 4, { width: p.w, align: p.align, lineBreak: false, ellipsis: true })
  }

  if (!filas.length) {
    doc.fillColor(B.GRIS).fontSize(9).font('Helvetica').text('Sin ventas en el período seleccionado.', left + PAD, y + 6)
    y += 24
  } else {
    filas.forEach((f, i) => {
      const rowH = 15
      if (y + rowH > doc.page.height - doc.page.margins.bottom - 26) {
        doc.addPage(); y = doc.page.margins.top; drawHead()
      }
      if (i % 2 === 1) doc.rect(left, y, width, rowH).fill('#fafafa')
      doc.fillColor(B.TINTA).font('Helvetica').fontSize(7.5)
      cell(cols[0], fmtFecha(f.fecha))
      cell(cols[1], f.nro_remito || '—')
      cell(cols[2], f.cantidad)
      cell(cols[3], f.cod)
      cell(cols[4], f.material)
      cell(cols[5], f.cliente)
      cell(cols[6], f.obra)
      cell(cols[7], B.money(f.precio_unit))
      doc.font('Helvetica-Bold'); cell(cols[8], B.money(f.importe)); doc.font('Helvetica')
      y += rowH
    })
  }

  // Total al pie
  doc.moveTo(left, y).lineTo(right, y).strokeColor(B.LINEA).lineWidth(1).stroke()
  y += 6
  const cImp = cols[8]
  doc.fillColor(B.TINTA).fontSize(10).font('Helvetica-Bold')
     .text('TOTAL', left, y, { width: (cImp.x - left) - PAD, align: 'right' })
     .text(B.money(total), cImp.x, y, { width: cImp.width - PAD, align: 'right' })

  B.drawFooter(doc, { extra: `${filas.length} renglón(es)` })
  doc.end()
}

module.exports = { generarLibroVentasPDF }
