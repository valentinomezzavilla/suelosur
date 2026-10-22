'use strict'
// Facturación con IVA sumado al neto: cálculos y PDF de detalle (sin base de datos).
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { PassThrough } = require('stream')
const { ivaDe, conIva, sinIva, etiqueta } = require('../src/utils/iva')
const { importesVenta } = require('../src/models/ventas.model')
const F = require('../src/models/facturacion.model')
const { generarFacturacionPDF, nombreArchivoFacturacion } = require('../src/utils/pdfFacturacion')

describe('utils/iva', () => {
  it('el ejemplo: $150.000 neto + 21% = $181.500', () => {
    assert.equal(ivaDe(150000, 21), 31500)
    assert.equal(conIva(150000, 21), 181500)
    assert.equal(sinIva(181500, 21), 150000)
  })
  it('sin alícuota no suma nada', () => {
    assert.equal(ivaDe(1000, null), 0)
    assert.equal(conIva(1000, 0), 1000)
    assert.equal(sinIva(1000, undefined), 1000)
  })
  it('redondea a centavos', () => {
    assert.equal(ivaDe(333.33, 21), 70)
    assert.equal(conIva(333.33, 21), 403.33)
    assert.equal(etiqueta(21), 'IVA 21%')
    assert.equal(etiqueta(10.5), 'IVA 10,5%')
  })
})

describe('importesVenta con IVA', () => {
  it('el total pactado es el neto y el total cobrado suma el IVA', () => {
    const r = importesVenta({ monto_total: 150000, precio_flete: 20000, iva_alicuota: 21 }, 130000)
    assert.equal(r.neto, 150000)
    assert.equal(r.iva, 31500)
    assert.equal(r.total, 181500)
    assert.equal(r.flete, 20000)
    assert.equal(r.ajuste, 0)
  })
  it('sin IVA (no es para facturar, o marcada con el criterio viejo) el total no cambia', () => {
    const r = importesVenta({ monto_total: null, precio_flete: 0, iva_alicuota: null }, 1000)
    assert.equal(r.total, 1000)
    assert.equal(r.iva, 0)
  })
  it('el ajuste del total editado se calcula contra el neto, no contra el total con IVA', () => {
    const r = importesVenta({ monto_total: 1100, precio_flete: 0, iva_alicuota: 21 }, 1000)
    assert.equal(r.ajuste, 100)
    assert.equal(r.total, 1331)
  })
})

describe('Facturación: neto, IVA y total de cada operación', () => {
  const fila = (extra) => ({
    id: 1, nro_op: 10, tipo_op: 'M', modalidad: 'deposito', estado: 'entregado', fecha_emision: '2026-10-20',
    para_facturar: 1, facturado: 0, cliente_id: 5, ...extra,
  })
  it('nueva (con IVA sumado): neto = lo cargado, IVA 21%, total = lo que se cobra', () => {
    const r = F.mapear(fila({ iva_alicuota: 21, neto_base: 150000, monto_final: 150000 }), '2026-10-22')
    assert.equal(r.con_iva, true)
    assert.equal(r.neto, 150000)
    assert.equal(r.iva, 31500)
    assert.equal(r.monto, 181500)
    assert.equal(r.sin_precio, false)
  })
  it('vieja (sin IVA sumado): el monto era el final y se desglosa hacia atrás', () => {
    const r = F.mapear(fila({ iva_alicuota: null, neto_base: 121, monto_final: 121 }), '2026-10-22')
    assert.equal(r.con_iva, false)
    assert.equal(r.monto, 121)
    assert.equal(r.neto, 100)
    assert.equal(r.iva, 21)
  })
  it('alquiler para facturar sin precio todavía: se marca sin precio', () => {
    const r = F.mapear(fila({ tipo_op: 'C', iva_alicuota: 21, neto_base: null, monto_final: 0 }), '2026-10-22')
    assert.equal(r.sin_precio, true)
    assert.equal(r.monto, 0)
  })
  it('factura C: sin IVA discriminado', () => {
    const op = F.mapear(fila({ iva_alicuota: 21, neto_base: 1000, monto_final: 1000 }), '2026-10-22')
    assert.deepEqual(F.desgloseOp(op, 'C'), { neto: 1210, iva: 0 })
    assert.deepEqual(F.desgloseOp(op, 'B'), { neto: 1000, iva: 210 })
  })
  it('facturada vieja: usa la alícuota con la que se facturó', () => {
    const r = F.mapear(fila({ facturado: 1, tipo_comprobante: 'A', alicuota_iva: 10.5, iva_alicuota: null, monto_final: 110.5 }), '2026-10-22')
    assert.equal(r.neto, 100)
    assert.equal(r.iva, 10.5)
  })
})

// res simulado: junta los bytes y los headers
function resFalso() {
  const s = new PassThrough()
  const partes = []
  s.headers = {}
  s.setHeader = (k, v) => { s.headers[k] = v }
  s.on('data', (c) => partes.push(c))
  s.terminado = new Promise((ok) => s.on('end', () => ok(Buffer.concat(partes))))
  return s
}
async function textosDelPDF(args) {
  const PDFDocument = require('pdfkit')
  const original = PDFDocument.prototype.text
  const textos = []
  PDFDocument.prototype.text = function (t, ...resto) { textos.push(String(t)); return original.call(this, t, ...resto) }
  const res = resFalso()
  try {
    generarFacturacionPDF(res, args)
    await res.terminado
  } finally {
    PDFDocument.prototype.text = original
  }
  return { textos, res }
}

describe('PDF de detalle de facturación', () => {
  const cliente = { nombre: 'JUAN PEREZ', razonSocial: 'PEREZ CONSTRUCCIONES SRL', cuit: '30712345678', condicion: 'Responsable Inscripto' }
  const operaciones = [{
    nro_op: 12, nro_remito: 5001, fecha: '2026-10-20', tipoTexto: 'Venta cantera', obra: 'Colón 100', neto: 150000,
    renglones: [{ descripcion: 'Arena fina', cantidad: 10, unidad: 'm³', precio_unit: 13000, importe: 130000 },
                { descripcion: 'Flete', cantidad: 1, unidad: '', precio_unit: 20000, importe: 20000 }],
  }]
  const totales = { neto: 150000, iva: 31500, total: 181500, alicuota: 21 }

  it('pendiente: detalle para facturar con neto, IVA y total', async () => {
    const { textos, res } = await textosDelPDF({ cliente, operaciones, totales, empresa: { cuit: '30700000001', condicion: 'Responsable Inscripto' } })
    assert.equal(res.headers['Content-Type'], 'application/pdf')
    assert.match(res.headers['Content-Disposition'], /detalle-facturar-perez-construcciones-srl-/)
    const todo = textos.join('\n')
    assert.ok(todo.includes('DETALLE PARA FACTURAR'))
    assert.ok(todo.includes('Subtotal neto'))
    assert.ok(todo.includes('IVA 21%'))
    assert.ok(todo.includes('$181.500,00'))
    assert.ok(todo.includes('$31.500,00'))
    assert.ok(todo.includes('Arena fina'))
    assert.ok(todo.includes('CUIT 30712345678'.split(' ')[1]))
  })

  it('facturada: lleva el comprobante y el CAE', async () => {
    const comprobante = { tipo: 'A', numero: '0001-00000012', fecha: '2026-10-21', cae: '75123456789012', caeVto: '2026-10-31', origen: 'afip' }
    const { textos, res } = await textosDelPDF({ cliente, operaciones, totales, comprobante })
    const todo = textos.join('\n')
    assert.ok(todo.includes('DETALLE DE FACTURA A'))
    assert.ok(todo.includes('N° 0001-00000012'))
    assert.ok(todo.includes('CAE 75123456789012'))
    assert.match(res.headers['Content-Disposition'], /factura-a-0001-00000012-perez-construcciones-srl/)
  })

  it('aviso cuando hay operaciones con el IVA incluido (criterio viejo)', async () => {
    const { textos } = await textosDelPDF({ cliente, operaciones, totales, ivaIncluido: true })
    assert.ok(textos.some(t => t.includes('IVA incluido')))
  })

  it('nombre de archivo sin razón social usa el nombre', () => {
    assert.match(nombreArchivoFacturacion({ cliente: { nombre: 'José Pérez' } }), /^detalle-facturar-jose-perez-/)
  })
})
