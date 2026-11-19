'use strict'
// Descuentos en pantalla: botones y modales en Liquidaciones (con cliente) y Cuenta corriente.
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { renderVista } = require('./helpers/vistas')
const { TIPOS, ESTADOS } = require('../src/utils/liquidaciones')

const filtros = { clienteId: '1', obra: [], desde: '2026-11-01', hasta: '2026-11-30', tipos: Object.keys(TIPOS), estadoPago: 'todas' }
const cliente = { id: 1, numero: 42, nombreCompleto: 'ARQ LUCAS RODRIGUEZ', dni: '', telefono: '', direccion: '', email: '' }
const op = { id: 9, nro_op: 308, nro_remito: 1234, fecha: '2026-11-06', tipo: 'viaje', tipoTexto: 'Venta con viaje', obra: null,
  metodoTexto: 'Efectivo', renglones: [{ descripcion: 'Arena fina', unidad: 'm³', cantidad: 2, precio_unit: 500, importe: 1000 },
    { descripcion: 'Descuento 10% (19/11/2026)', unidad: '', cantidad: 1, precio_unit: -100, importe: -100, esDescuento: true }],
  total: 900, pagado: 0, resta: 900, estado: 'pendiente' }
const base = { titulo: 'Liquidaciones', TIPOS, ESTADOS, nro: 'LIQ-20261119-0001', obras: [], scripts: [] }
const liquidacion = (ops) => ({ clientes: [{ cliente, operaciones: ops, resumen: { consumido: 900, pagado: 0, saldo: 900, cantidad: ops.length }, pagos: [], porObra: [] }],
  resumen: { consumido: 900, pagado: 0, saldo: 900, cantidad: ops.length } })

describe('vista: descuentos en Liquidaciones', () => {
  it('con cliente: "Agregar descuento" y el modal; sin vigentes no está "Ver descuentos aplicados"', async () => {
    const html = await renderVista('pages/liquidaciones/index', { ...base, filtros, clienteSel: cliente, liquidacion: liquidacion([op]) })
    assert.match(html, /Agregar descuento/)
    assert.match(html, /id="modal-descuento"/)
    assert.match(html, /data-desc-cliente="1"/)
    assert.match(html, /data-desc-filtros="clienteId=1&amp;desde=2026-11-01/)
    assert.doesNotMatch(html, /js-desc-ver/)
    assert.match(html, /Descuento 10% \(19\/11\/2026\)/)
  })
  it('con descuentos vigentes: "Ver descuentos aplicados" con la cantidad', async () => {
    const html = await renderVista('pages/liquidaciones/index', { ...base, filtros, clienteSel: cliente, liquidacion: liquidacion([op]), descuentosVigentes: 2 })
    assert.match(html, /Ver descuentos aplicados <span class="desc-barra__cuenta">2<\/span>/)
  })
  it('sin cliente: no hay descuentos', async () => {
    const html = await renderVista('pages/liquidaciones/index', { ...base, filtros: { ...filtros, clienteId: null }, clienteSel: null, liquidacion: liquidacion([op]) })
    assert.doesNotMatch(html, /Agregar descuento/)
  })
  it('un rol sin permiso no ve los botones', async () => {
    const html = await renderVista('pages/liquidaciones/index', { ...base, filtros, clienteSel: cliente, liquidacion: liquidacion([op]), user: { rol: 'admin_ventas' } })
    assert.doesNotMatch(html, /Agregar descuento/)
  })
})

describe('PDF: descuentos', () => {
  const { PassThrough } = require('stream')
  const { generarLiquidacionPDF } = require('../src/utils/pdfLiquidacion')
  it('con renglón de descuento y descuentos sobre el saldo: genera el PDF', async () => {
    const s = new PassThrough(); const partes = []; s.setHeader = () => {}
    s.on('data', (c) => partes.push(c))
    const fin = new Promise((ok) => s.on('end', () => ok(Buffer.concat(partes))))
    const saldo = { cuenta: { saldo: -800, deuda: 800, aFavor: 0, desglose: { periodo: 800, anteriores: 0, posteriores: 0, manuales: 0 }, creditos: [] },
      sinCobrar: { ops: [], total: 0, enPeriodo: 0 }, enCurso: { ops: [], total: 0 }, programadas: { ops: [], total: 0 }, total: 800 }
    generarLiquidacionPDF(s, { liquidacion: { ...liquidacion([op]), saldo, descuentosSaldo: [{ fecha: '2026-11-19', etiqueta: '$ 100', monto: 100 }] }, filtros, general: false })
    const pdf = await fin
    assert.equal(pdf.subarray(0, 5).toString(), '%PDF-')
  })
})
