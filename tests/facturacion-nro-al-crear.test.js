'use strict'
// N° de Factura cargado con la operación "Para facturar": queda guardado con la OP (que sigue
// pendiente en Facturación), se busca por él en Ventas y en Facturación y viene cargado al
// facturarla. También se carga o se corrige desde el detalle de la operación (y, para cualquier
// operación, con el botón de los listados: ver nro-factura-operaciones.test.js).
// Corre dentro de la transacción de prueba (ROLLBACK al final: nada queda guardado).
const prueba = require('./helpers/db')
const datos = require('./helpers/datos')
const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { renderVista } = require('./helpers/vistas')
const VentasController = require('../src/controllers/ventas.controller')
const FacturacionController = require('../src/controllers/facturacion.controller')
const FacturacionModel = require('../src/models/facturacion.model')

function llamar(Controller, accion, { body = {}, params = {}, query = {}, user }) {
  return new Promise((resolve, reject) => {
    const flashes = []
    const req = { body, params, query, session: { user }, flash: (tipo, msg) => flashes.push({ tipo, msg }), get: () => null }
    const res = { locals: {}, redirect: (url) => resolve({ url, flashes }), render: (vista, data) => resolve({ vista, data, flashes }), status: () => res }
    Promise.resolve(Controller[accion](req, res)).catch(reject)
  })
}

describe('N° de Factura al crear una operación para facturar', () => {
  let user, producto, cliente

  before(async () => {
    await prueba.abrir()
    user = { id: await datos.idAdministrativo(), rol: 'dueno' }
    producto = (await prueba.q(`INSERT INTO productos (nombre, unidad_medida, precio_cantera, precio_viaje, activo, depende_stock)
      VALUES ('Arena prueba nro factura', 'm³', 1000, 1200, 1, 0) RETURNING id`)).rows[0].id
    cliente = await datos.crearCliente()
  })
  after(() => prueba.cerrar())

  const ventaCantera = async (extra = {}) => {
    const r = await llamar(VentasController, 'finalizarCantera', { user, body: {
      clienteId: String(cliente), clienteNombre: 'PRUEBA', metodoPago: 'efectivo',
      items: JSON.stringify([{ id: producto, cantidad: 2 }]), ...extra,
    } })
    assert.ok(!r.flashes.some(f => f.tipo === 'error'), JSON.stringify(r.flashes))
    return (await prueba.q(`SELECT * FROM op_encabezado WHERE id_cliente = ? ORDER BY id DESC LIMIT 1`, [cliente])).rows[0]
  }

  let op
  it('la venta para facturar guarda el N° de Factura y sigue pendiente', async () => {
    op = await ventaCantera({ paraFacturar: '1', nroFactura: '  0001-00009911 ' })
    assert.equal(op.nro_factura, '0001-00009911')
    assert.equal(Number(op.para_facturar), 1)
    assert.equal(Number(op.facturado || 0), 0)
    const estado = await FacturacionModel.estadoOp(op.id)
    assert.equal(estado.comprobante, null)   // no es una factura registrada
  })

  it('sin "Para facturar" el número no se guarda', async () => {
    const otra = await ventaCantera({ nroFactura: '0001-00009912' })
    assert.equal(otra.nro_factura, null)
  })

  it('se busca por N° de Factura en Ventas', async () => {
    const v = await llamar(VentasController, 'index', { user, query: { q: '00009911' } })
    const ids = v.data.ops.map(o => Number(o.id))
    assert.ok(ids.includes(Number(op.id)), 'la venta no aparece al buscar por N° de factura')
  })

  it('Facturación la muestra pendiente con su número, la encuentra y lo precarga al facturar', async () => {
    const v = await llamar(FacturacionController, 'index', { user, query: { tab: 'pendiente', q: '00009911' } })
    assert.deepEqual(v.data.lista.map(o => Number(o.id)), [Number(op.id)])
    const html = await renderVista(v.vista, { ...v.data, scripts: [] })
    assert.match(html, /Fact\. <span class="fw-semibold">0001-00009911<\/span>/)
    assert.match(html, /data-nro-factura="0001-00009911"/)
  })

  it('desde el detalle se corrige el número (y vacío lo borra)', async () => {
    let r = await llamar(FacturacionController, 'nroFactura', { user, params: { id: op.id }, body: { nroFactura: '0001-00009999', volver: '/ventas/' + op.id } })
    assert.equal(r.url, '/ventas/' + op.id)
    assert.equal((await FacturacionModel.estadoOp(op.id)).nro_factura, '0001-00009999')
    await llamar(FacturacionController, 'nroFactura', { user, params: { id: op.id }, body: { nroFactura: '' } })
    assert.equal((await FacturacionModel.estadoOp(op.id)).nro_factura, null)
  })

  it('marcar con número lo guarda; quitarla de facturación conserva el número (es un dato de la operación)', async () => {
    const otra = await ventaCantera()
    await llamar(FacturacionController, 'marcar', { user, params: { id: otra.id }, body: { nroFactura: '0002-00000001' } })
    const e = await FacturacionModel.estadoOp(otra.id)
    assert.equal(e.para_facturar, true)
    assert.equal(e.nro_factura, '0002-00000001')
    await llamar(FacturacionController, 'quitar', { user, params: { id: otra.id }, body: {} })
    const q = await FacturacionModel.estadoOp(otra.id)
    assert.equal(q.para_facturar, false)
    assert.equal(q.nro_factura, '0002-00000001')
  })

  it('una operación ya facturada no cambia su número desde el detalle', async () => {
    await prueba.q(`UPDATE op_encabezado SET facturado = 1, nro_factura = 'A-1' WHERE id = ?`, [op.id])
    const r = await llamar(FacturacionController, 'nroFactura', { user, params: { id: op.id }, body: { nroFactura: 'otro' } })
    assert.match(r.flashes[0].msg, /ya está facturada/)
    assert.equal((await FacturacionModel.estadoOp(op.id)).nro_factura, 'A-1')
  })
})
