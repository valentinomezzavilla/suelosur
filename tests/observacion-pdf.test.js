'use strict'
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { PassThrough } = require('stream')
const PDFDocument = require('pdfkit')
const { generarLiquidacionPDF, leerObservacion } = require('../src/utils/pdfLiquidacion')

function resFalso() {
  const s = new PassThrough()
  const partes = []
  s.headers = {}
  s.setHeader = (k, v) => { s.headers[k] = v }
  s.on('data', (c) => partes.push(c))
  s.terminado = new Promise((ok) => s.on('end', () => ok(Buffer.concat(partes))))
  return s
}

// Captura los textos que escribe pdfkit (el PDF sale comprimido)
async function textosDe(fn) {
  const textos = []
  const orig = PDFDocument.prototype.text
  PDFDocument.prototype.text = function (t, ...r) { if (typeof t === 'string') textos.push(t); return orig.call(this, t, ...r) }
  try {
    const res = resFalso()
    fn(res)
    const pdf = await res.terminado
    assert.equal(pdf.subarray(0, 5).toString(), '%PDF-')
  } finally { PDFDocument.prototype.text = orig }
  return textos
}

const op = { id: 1, nro_op: 301, nro_remito: 1001, fecha: '2026-10-05', tipo: 'viaje', tipoTexto: 'Venta con viaje', obra: 'Colón 100',
  renglones: [{ descripcion: 'Arena fina', unidad: 'm³', cantidad: 2, precio_unit: 500, importe: 1000 }],
  total: 1000, pagado: 0, resta: 1000, estado: 'pendiente' }
const cliente = { id: 1, numero: 42, nombreCompleto: 'ARQ LUCAS RODRIGUEZ', dni: '30111222' }
const resumen = { consumido: 1000, pagado: 0, saldo: 1000, cantidad: 1 }
const filtros = { clienteId: '1', obra: [], desde: '2026-10-01', hasta: '2026-10-31', tipos: ['viaje'], estadoPago: 'todas' }
const liqCliente = { clientes: [{ cliente, operaciones: [op], resumen, porObra: [] }], resumen, obra: null }

describe('Observación en el PDF de liquidación / cuenta corriente', () => {
  it('con observación: sale la sección "Observaciones" con el texto', async () => {
    const textos = await textosDe((res) => generarLiquidacionPDF(res, { liquidacion: liqCliente, filtros, general: false, observacion: 'Entregar en obra antes del viernes' }))
    assert.ok(textos.includes('OBSERVACIONES'))
    assert.ok(textos.includes('Entregar en obra antes del viernes'))
  })

  it('sin observación: no sale la sección', async () => {
    const textos = await textosDe((res) => generarLiquidacionPDF(res, { liquidacion: liqCliente, filtros, general: false }))
    assert.ok(!textos.includes('OBSERVACIONES'))
  })

  it('liquidación general: la observación va en la primera página', async () => {
    const textos = await textosDe((res) => generarLiquidacionPDF(res, { liquidacion: liqCliente, filtros: { ...filtros, clienteId: null }, general: true, observacion: 'Nota general' }))
    assert.ok(textos.includes('Nota general'))
    assert.ok(textos.indexOf('RESUMEN POR CLIENTE') < textos.indexOf('Nota general'))
    assert.ok(textos.indexOf('Nota general') < textos.indexOf('DETALLE DE OPERACIONES'))
  })

  it('leerObservacion: recorta espacios, largo y renglones; ignora lo que no es texto', () => {
    assert.equal(leerObservacion('  hola \r\n chau  '), 'hola \n chau')
    assert.equal(leerObservacion(undefined), '')
    assert.equal(leerObservacion(['a', 'b']), 'a')
    assert.equal(leerObservacion('x'.repeat(2000)).length, 1000)
    assert.equal(leerObservacion(Array.from({ length: 50 }, (_, i) => 'r' + i).join('\n')).split('\n').length, 30)
  })

  it('las pantallas abren el modal antes del PDF', () => {
    for (const v of ['views/pages/clientes/cuenta_detalle.ejs', 'views/pages/liquidaciones/index.ejs']) {
      const s = fs.readFileSync(path.join(__dirname, '..', v), 'utf8')
      assert.match(s, /\/pdf\?[^"]*" target="_blank" data-pdf-observacion/)
      assert.match(s, /partials\/modal_observacion_pdf/)
    }
  })
})
