'use strict'
// ─────────────────────────────────────────────────────────────────
// pdfLibroVentas.js — Libro de ventas en PDF (apaisado).
// Columnas: Fecha · Remito · Cant. · Cód · Material · [Cliente] · Obra
//           · Precio unitario · Importe. Con total al pie.
// La columna Cliente solo aparece si el libro no está filtrado a un cliente
// puntual (si lo está, ya se ve en el encabezado y sobra en cada renglón).
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

  // Columna CLIENTE: solo tiene sentido cuando el libro mezcla varios clientes. Si ya
  // está filtrado a uno (clienteLabel), el cliente ya se ve arriba y la columna sobra —
  // ese lugar se reparte entre MATERIAL y OBRA, que son las que más lo necesitan.
  const conCliente = !clienteLabel
  const cols = conCliente ? [
    { key: 'fecha',       label: 'FECHA',    w: 0.09,  align: 'left'  },
    { key: 'nro_remito',  label: 'REMITO',   w: 0.07,  align: 'left'  },
    { key: 'cantidad',    label: 'CANT.',    w: 0.06,  align: 'right' },
    { key: 'cod',         label: 'CÓD',      w: 0.05,  align: 'left'  },
    { key: 'material',    label: 'MATERIAL', w: 0.15,  align: 'left'  },
    { key: 'cliente',     label: 'CLIENTE',  w: 0.19,  align: 'left'  },
    { key: 'obra',        label: 'OBRA',     w: 0.19,  align: 'left'  },
    { key: 'precio_unit', label: 'P. UNIT.', w: 0.10,  align: 'right' },
    { key: 'importe',     label: 'IMPORTE',  w: 0.10,  align: 'right' },
  ] : [
    { key: 'fecha',       label: 'FECHA',    w: 0.09,  align: 'left'  },
    { key: 'nro_remito',  label: 'REMITO',   w: 0.07,  align: 'left'  },
    { key: 'cantidad',    label: 'CANT.',    w: 0.06,  align: 'right' },
    { key: 'cod',         label: 'CÓD',      w: 0.05,  align: 'left'  },
    { key: 'material',    label: 'MATERIAL', w: 0.22,  align: 'left'  },
    { key: 'obra',        label: 'OBRA',     w: 0.26,  align: 'left'  },
    { key: 'precio_unit', label: 'P. UNIT.', w: 0.125, align: 'right' },
    { key: 'importe',     label: 'IMPORTE',  w: 0.125, align: 'right' },
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

  // Material, cliente y obra se parten en varias líneas; el resto va en una sola
  const ENVUELVEN = ['material', 'cliente', 'obra']
  const cell = (c, val) => {
    if (!c) return
    const p = place(c)
    const opts = ENVUELVEN.includes(c.key)
      ? { width: p.w, align: p.align }
      : { width: p.w, align: p.align, lineBreak: false, ellipsis: true }
    doc.text(val == null ? '' : String(val), p.x, y + 4, opts)
  }
  const col = (key) => cols.find(c => c.key === key)
  const valores = {
    fecha: (f) => fmtFecha(f.fecha), nro_remito: (f) => f.nro_remito || '—',
    cantidad: (f) => f.cantidad, cod: (f) => f.cod, material: (f) => f.material,
    cliente: (f) => f.cliente, obra: (f) => f.obra,
    precio_unit: (f) => B.money(f.precio_unit), importe: (f) => B.money(f.importe),
  }

  if (!filas.length) {
    doc.fillColor(B.GRIS).fontSize(9).font('Helvetica').text('Sin ventas en el período seleccionado.', left + PAD, y + 6)
    y += 24
  } else {
    filas.forEach((f, i) => {
      doc.font('Helvetica').fontSize(7.5)
      const altoTexto = cols.filter(c => ENVUELVEN.includes(c.key)).reduce((max, c) =>
        Math.max(max, doc.heightOfString(String(valores[c.key](f) ?? '') || ' ', { width: place(c).w })), 9)
      const rowH = altoTexto + 6
      if (y + rowH > doc.page.height - doc.page.margins.bottom - 26) {
        doc.addPage(); y = doc.page.margins.top; drawHead()
      }
      if (i % 2 === 1) doc.rect(left, y, width, rowH).fill('#fafafa')
      doc.fillColor(B.TINTA).font('Helvetica').fontSize(7.5)
      cols.forEach(c => {
        if (c.key === 'importe') { doc.font('Helvetica-Bold'); cell(c, valores[c.key](f)); doc.font('Helvetica') }
        else cell(c, valores[c.key](f))
      })
      y += rowH
    })
  }

  // Total al pie
  doc.moveTo(left, y).lineTo(right, y).strokeColor(B.LINEA).lineWidth(1).stroke()
  y += 6
  const cImp = col('importe')
  doc.fillColor(B.TINTA).fontSize(10).font('Helvetica-Bold')
     .text('TOTAL', left, y, { width: (cImp.x - left) - PAD, align: 'right' })
     .text(B.money(total), cImp.x, y, { width: cImp.width - PAD, align: 'right' })

  B.drawFooter(doc, { extra: `${filas.length} renglón(es)` })
  doc.end()
}

module.exports = { generarLibroVentasPDF }
