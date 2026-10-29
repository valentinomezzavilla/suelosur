'use strict'
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { renderVista } = require('./helpers/vistas')
const { TIPOS, ESTADOS } = require('../src/utils/liquidaciones')

const filtros = { clienteId: '1', obra: null, desde: '2026-10-01', hasta: '2026-10-31', tipos: Object.keys(TIPOS), estadoPago: 'todas' }
const op = { id: 9, nro_op: 308, nro_remito: 1234, fecha: '2026-10-06', tipo: 'viaje', tipoTexto: 'Venta con viaje', obra: 'Colón 100',
  metodoTexto: 'Efectivo', renglones: [{ descripcion: 'Arena fina', unidad: 'm³', cantidad: 2, precio_unit: 500, importe: 1000 }],
  total: 1000, pagado: 400, resta: 600, estado: 'parcial' }
const cliente = { id: 1, numero: 42, nombreCompleto: 'ARQ LUCAS RODRIGUEZ', dni: '', telefono: '', direccion: '', email: '' }
const base = { titulo: 'Liquidaciones', TIPOS, ESTADOS, nro: 'LIQ-20261006-0001', obras: [], scripts: [] }

describe('vista liquidaciones', () => {
  it('con cliente: tarjetas, operación con detalle y pagos', async () => {
    const html = await renderVista('pages/liquidaciones/index', { ...base, filtros, clienteSel: cliente,
      liquidacion: { clientes: [{ cliente, operaciones: [op], resumen: { consumido: 1000, pagado: 400, saldo: 600, cantidad: 1 },
        pagos: [{ fecha: '2026-10-06', metodoTexto: 'Efectivo', descripcion: 'Cobro', monto: 400 }], porObra: [] }],
        resumen: { consumido: 1000, pagado: 400, saldo: 600, cantidad: 1 } } })
    assert.match(html, /Remito 1234/)
    assert.doesNotMatch(html, /OP-0308/)
    assert.match(html, /Arena fina/)
    assert.match(html, /Parcial/)
    assert.match(html, /Pagos recibidos/)
    assert.match(html, /\/liquidaciones\/pdf\?/)
  })
  it('con cliente: el buscador queda visible (si no, "Cambiar" deja el campo vacío)', async () => {
    const html = await renderVista('pages/liquidaciones/index', { ...base, filtros, clienteSel: cliente,
      liquidacion: { clientes: [{ cliente, operaciones: [], resumen: { consumido: 0, pagado: 0, saldo: 0, cantidad: 0 }, pagos: [], porObra: [] }],
        resumen: { consumido: 0, pagado: 0, saldo: 0, cantidad: 0 } } })
    const input = html.match(/<input[^>]*id="buscarClienteInput"[^>]*>/)[0]
    assert.doesNotMatch(input, /display:\s*none/)
  })
  it('sin cliente: tabla resumen por cliente y obra deshabilitada', async () => {
    const html = await renderVista('pages/liquidaciones/index', { ...base, filtros: { ...filtros, clienteId: null }, clienteSel: null,
      liquidacion: { clientes: [{ cliente, operaciones: [op], resumen: { consumido: 1000, pagado: 400, saldo: 600, cantidad: 1 }, pagos: null, porObra: [] }],
        resumen: { consumido: 1000, pagado: 400, saldo: 600, cantidad: 1 } } })
    assert.match(html, /Resumen por cliente/)
    assert.match(html, /clienteId=1/)
    assert.match(html, /id="filtroObra"[^>]*disabled/)
    assert.doesNotMatch(html, /Pagos recibidos/)
  })
  it('casillas y barra para marcar / quitar para facturar en grupo', async () => {
    const ops = [
      { ...op, id: 1, nro_remito: 1, paraFacturar: false, facturado: false, neto: 1000, iva: 0 },
      { ...op, id: 2, nro_remito: 2, paraFacturar: true, facturado: false, neto: 1000, iva: 210 },
      { ...op, id: 3, nro_remito: 3, paraFacturar: true, facturado: true, neto: 1000, iva: 210 },
    ]
    const html = await renderVista('pages/liquidaciones/index', { ...base, filtros, clienteSel: cliente,
      liquidacion: { clientes: [{ cliente, operaciones: ops, resumen: { consumido: 3000, pagado: 0, saldo: 3000, cantidad: 3 }, pagos: [], porObra: [] }],
        resumen: { consumido: 3000, pagado: 0, saldo: 3000, cantidad: 3 } } })
    const casillas = html.match(/<input type="checkbox" class="liq-op__sel[^>]*>/g)
    assert.equal(casillas.length, 3)
    assert.match(casillas[0], /value="1"[\s\S]*data-marcada="0"/)
    assert.doesNotMatch(casillas[0], /disabled/)
    assert.match(casillas[1], /data-iva="210"[\s\S]*data-marcada="1"/)
    assert.match(casillas[2], /disabled/)
    assert.match(html, /badge-pendiente">Para facturar/)
    assert.match(html, /badge-activo">Facturada/)
    assert.match(html, /<form method="POST" action="\/facturacion\/marcar-varias" id="formFacturarGrupo"/)
    assert.match(html, /formaction="\/facturacion\/quitar-varias"/)
    assert.match(html, /name="volver" value="\/liquidaciones\?clienteId=1&amp;desde=2026-10-01/)
  })
  it('sin operaciones', async () => {
    const html = await renderVista('pages/liquidaciones/index', { ...base, filtros, clienteSel: cliente,
      liquidacion: { clientes: [{ cliente, operaciones: [], resumen: { consumido: 0, pagado: 0, saldo: 0, cantidad: 0 }, pagos: [], porObra: [] }],
        resumen: { consumido: 0, pagado: 0, saldo: 0, cantidad: 0 } } })
    assert.match(html, /Sin operaciones en el período/)
    assert.doesNotMatch(html, /formFacturarGrupo/)
  })
})
