'use strict'
// Carga de combustible de un camión con N° de factura, N° de remito y hora (además de
// litros y chofer), y la forma de pago "Otros" en los pagos a proveedores (Compras / Pagos
// y pago a una estación de servicio).
// Corre dentro de la transacción de prueba (ROLLBACK al final: nada queda guardado).
const prueba = require('./helpers/db')
const datos = require('./helpers/datos')
const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { renderVista } = require('./helpers/vistas')
const FlotaController = require('../src/controllers/flota.controller')
const ComprasController = require('../src/controllers/compras.controller')
const EstacionesController = require('../src/controllers/estaciones.controller')
const ProveedoresController = require('../src/controllers/proveedores.controller')
const CombustibleModel = require('../src/models/combustible.model')
const EstacionesModel = require('../src/models/estaciones.model')

function llamar(ctrl, accion, { body = {}, params = {}, query = {}, user }) {
  return new Promise((resolve, reject) => {
    const flashes = []
    const req = { body, params, query, session: { user }, flash: (tipo, msg) => flashes.push({ tipo, msg }), get: () => null }
    const res = { locals: {}, redirect: (url) => resolve({ url, flashes }), render: (vista, data) => resolve({ vista, data, flashes }) }
    Promise.resolve(ctrl[accion](req, res)).catch(reject)
  })
}

let user
before(async () => {
  await prueba.abrir()
  user = { id: await datos.idAdministrativo(), rol: 'dueno' }
})
after(() => prueba.cerrar())

describe('carga de combustible: factura, remito y hora', () => {
  let camion, estacion

  before(async () => {
    camion = (await prueba.q(`INSERT INTO flota_vehiculos (nombre, patente, tipo_vehiculo) VALUES ('Camión prueba campos', 'ZZ998ZZ', 'camion') RETURNING id`)).rows[0].id
    await llamar(ProveedoresController, 'crear', { user, body: { nombre: 'Estación Prueba Campos', es_estacion: '1' } })
    estacion = (await prueba.q(`SELECT id FROM proveedores WHERE nombre = 'Estación Prueba Campos'`)).rows[0].id
  })

  it('la carga guarda N° de factura, N° de remito y hora (recortados)', async () => {
    const r = await llamar(FlotaController, 'cargarCombustible', { user, params: { id: camion }, body: {
      fecha: '2026-10-20', hora: '08:30', nro_factura: '  0003-00012345 ', nro_remito: ' R-5566 ', litros: '120.5',
      costo_total: '150000', km_al_cargar: '', id_chofer: '', id_proveedor: String(estacion) } })
    assert.equal(r.url, `/flota/${camion}?tab=combustible`)
    assert.ok(r.flashes.some(f => f.tipo === 'success'), JSON.stringify(r.flashes))
    const c = (await prueba.q(`SELECT * FROM combustible WHERE id_vehiculo = ?`, [camion])).rows[0]
    assert.equal(c.nro_factura, '0003-00012345')
    assert.equal(c.nro_remito, 'R-5566')
    assert.equal(c.hora, '08:30')
    assert.equal(Number(c.litros), 120.5)
  })

  it('sin hora, factura ni remito quedan vacíos; una hora inválida no se guarda', async () => {
    await CombustibleModel.crear({ id_vehiculo: camion, litros: '10', costo_total: '1000', fecha: '2026-10-20', hora: '25:99' })
    await CombustibleModel.crear({ id_vehiculo: camion, litros: '20', costo_total: '2000', fecha: '2026-10-20', hora: '7:05' })
    const filas = (await prueba.q(`SELECT litros, hora, nro_factura, nro_remito FROM combustible WHERE id_vehiculo = ? AND litros < 100 ORDER BY litros`, [camion])).rows
    assert.equal(filas[0].hora, null)
    assert.equal(filas[0].nro_factura, null)
    assert.equal(filas[0].nro_remito, null)
    assert.equal(filas[1].hora, '07:05')
  })

  it('el listado ordena las cargas del mismo día por hora (la más nueva primero)', async () => {
    const lista = await CombustibleModel.listar(camion)
    assert.deepEqual(lista.map(c => Number(c.litros)), [120.5, 20, 10])
  })

  it('la cuenta de la estación muestra la factura y el remito de la carga', async () => {
    const c = await EstacionesModel.cuenta(estacion)
    const carga = c.movimientos.find(m => m.origen === 'carga')
    assert.match(carga.descripcion, /Fact\. 0003-00012345/)
    assert.match(carga.descripcion, /Rem\. R-5566/)
  })

  it('la pestaña Combustible del camión pide los campos y los muestra en la tabla', async () => {
    const v = await llamar(FlotaController, 'detalle', { user, params: { id: camion }, query: { tab: 'combustible', mes: '2026-10' } })
    assert.equal(v.vista, 'pages/flota/detalle')
    const html = await renderVista(v.vista, { ...v.data, scripts: [] })
    for (const campo of ['nro_factura', 'nro_remito', 'litros', 'id_chofer', 'hora']) {
      assert.match(html, new RegExp(`name="${campo}"`), `falta el campo ${campo}`)
    }
    assert.match(html, /type="time" name="hora"/)
    assert.match(html, /N° Factura/)
    assert.match(html, /N° Remito/)
    assert.match(html, /<small>08:30<\/small>/)
    assert.match(html, /<small>0003-00012345<\/small>/)
    assert.match(html, /<small>R-5566<\/small>/)
  })
})

describe('forma de pago "Otros" en los pagos a proveedores', () => {
  let estacion

  before(async () => {
    await llamar(ProveedoresController, 'crear', { user, body: { nombre: 'Estación Prueba Otros', es_estacion: '1' } })
    estacion = (await prueba.q(`SELECT id FROM proveedores WHERE nombre = 'Estación Prueba Otros'`)).rows[0].id
  })

  it('Compras / Pagos guarda "otros" y lo muestra como "Otros"', async () => {
    await llamar(ComprasController, 'crear', { user, body: { categoria: 'combustible', fecha: '2026-10-21', monto: '5000', metodo_pago: 'otros', id_proveedor: String(estacion) } })
    const e = (await prueba.q(`SELECT metodo_pago FROM egresos WHERE id_proveedor = ? ORDER BY id DESC LIMIT 1`, [estacion])).rows[0]
    assert.equal(e.metodo_pago, 'otros')

    const form = await llamar(ComprasController, 'nueva', { user })
    const htmlForm = await renderVista(form.vista, { ...form.data, scripts: [] })
    assert.match(htmlForm, /<option value="otros">Otros<\/option>/)

    const idx = await llamar(ComprasController, 'index', { user, query: { metodoPago: 'otros', preset: 'rango', fechaDesde: '2026-10-01', fechaHasta: '2026-10-31' } })
    const htmlIdx = await renderVista(idx.vista, { ...idx.data, scripts: [] })
    assert.match(htmlIdx, /<option value="otros" selected>Otros<\/option>/)
    assert.match(htmlIdx, /<small class="text-muted">Otros<\/small>/)
  })

  it('el pago a una estación acepta "Otros" (no lo cambia a efectivo)', async () => {
    await llamar(EstacionesController, 'registrarPago', { user, params: { id: estacion }, body: { monto: '3000', metodo_pago: 'otros', fecha: '2026-10-22' } })
    const e = (await prueba.q(`SELECT metodo_pago FROM egresos WHERE id_proveedor = ? ORDER BY id DESC LIMIT 1`, [estacion])).rows[0]
    assert.equal(e.metodo_pago, 'otros')

    const v = await llamar(EstacionesController, 'cuenta', { user, params: { id: estacion } })
    const html = await renderVista(v.vista, { ...v.data, scripts: [] })
    assert.match(html, /<option value="otros">Otros<\/option>/)
    assert.match(html, / · Otros/)
  })
})
