'use strict'
// Transacciones: buscar por el código que muestra la tabla (PAG-001240, CAN-000045…), en el
// campo "Código" o escribiéndolo en la caja de nombres. Corre dentro de la transacción de
// prueba (ROLLBACK al final).
const prueba = require('./helpers/db')
const datos = require('./helpers/datos')
const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const MovimientosDineroModel = require('../src/models/movimientosDinero.model')
const TransaccionesModel = require('../src/models/transacciones.model')
const ClientesModel = require('../src/models/clientes.model')
const TransaccionesController = require('../src/controllers/transacciones.controller')
const { renderVista } = require('./helpers/vistas')

describe('codigoDeTexto', () => {
  const c = MovimientosDineroModel.codigoDeTexto
  it('entiende los códigos de la tabla, en cualquier forma de escribirlos', () => {
    for (const t of ['PAG-001240', 'pag-001240', 'PAG 1240', 'PAG1240', '  Pag-1240 ']) {
      assert.deepEqual(c(t), { origen: 'pago_cliente', id: 1240 }, t)
    }
    assert.deepEqual(c('EGR-000123'), { origen: 'egreso', id: 123 })
    assert.deepEqual(c('CAN-000045'), { origen: 'transaccion', tipo: 'Venta Cantera', numero: 45 })
    assert.deepEqual(c('VIA-000007'), { origen: 'transaccion', tipo: 'Venta Viaje', numero: 7 })
    assert.deepEqual(c('CON-000007'), { origen: 'transaccion', tipo: 'Alquiler', numero: 7 })
    assert.deepEqual(c('MAQ-000007'), { origen: 'transaccion', tipo: 'Maquinaria', numero: 7 })
    assert.deepEqual(c('AJU-000007'), { origen: 'transaccion', tipo: 'Ajuste', numero: 7 })
  })
  it('solo dígitos vale como N° de cualquier tipo; lo que no se entiende, nada', () => {
    assert.deepEqual(c('1240'), { cualquiera: 1240 })
    for (const t of ['', '   ', 'abc', 'XYZ-123', 'PAG-', 'PAG-12a']) assert.equal(c(t), null, t)
  })
  it('estricto (caja de nombres): solo con prefijo conocido, un nombre sigue siendo un nombre', () => {
    assert.equal(c('1240', { estricto: true }), null)
    assert.equal(c('CO.C STUDIO', { estricto: true }), null)
    assert.deepEqual(c('PAG-001240', { estricto: true }), { origen: 'pago_cliente', id: 1240 })
  })
})

describe('buscar por código en Transacciones', () => {
  let cli, pagoA, pagoB, txCan, user
  before(async () => {
    await prueba.abrir()
    user = { id: await datos.idAdministrativo(), rol: 'dueno' }
    cli = await datos.crearCliente({ cuentaCorriente: true })
    await prueba.q(`UPDATE clientes SET nombre = 'CO.C', apellido = 'STUDIO COD' WHERE id = ?`, [cli])
    pagoA = await ClientesModel.agregarMovimiento(cli, { tipo: 'pago', descripcion: 'Pago A', monto: 336000, metodo_pago: 'efectivo' })
    pagoB = await ClientesModel.agregarMovimiento(cli, { tipo: 'pago', descripcion: 'Pago B', monto: 336000, metodo_pago: 'efectivo' })
    txCan = await TransaccionesModel.crear({ tipo: 'Venta Cantera', cliente_id: cli, cliente: 'CO.C', monto: 500, metodo_pago: 'efectivo', descripcion: 'Venta de prueba' })
  })
  after(() => prueba.cerrar())

  const buscar = async (filtros) => (await MovimientosDineroModel.listar({ limit: 50, ...filtros })).rows
  const cod = (id) => 'PAG-' + String(id).padStart(6, '0')

  it('el código completo, como lo muestra la tabla, trae ese pago y nada más (el caso PAG-001240)', async () => {
    const r = await buscar({ codigo: cod(pagoA) })
    assert.deepEqual(r.map(f => [f.origen, Number(f.id)]), [['pago_cliente', pagoA]])
    assert.equal(MovimientosDineroModel.codigo(r[0]), cod(pagoA))
  })

  it('escribirlo en la caja "Cliente / persona" también lo encuentra', async () => {
    const r = await buscar({ cliente: cod(pagoB).toLowerCase() })
    assert.deepEqual(r.map(f => Number(f.id)), [pagoB])
    // y un nombre sigue buscando por nombre
    const porNombre = await buscar({ cliente: 'studio cod' })
    assert.ok([pagoA, pagoB].every(id => porNombre.some(f => f.origen === 'pago_cliente' && Number(f.id) === id)))
  })

  it('las transacciones se buscan por su N° de cada tipo (el que muestra la tabla), no por el id interno', async () => {
    const tx = (await prueba.q(`SELECT id, numero, tipo FROM transacciones WHERE id = ?`, [txCan])).rows[0]
    const r = await buscar({ codigo: TransaccionesModel.codigo(tx) })
    assert.deepEqual(r.map(f => [f.origen, Number(f.id)]), [['transaccion', txCan]])
  })

  it('un código que no existe no trae nada (en vez de traer todo)', async () => {
    assert.deepEqual(await buscar({ codigo: 'PAG-999999999' }), [])
    assert.deepEqual(await buscar({ codigo: 'cualquier cosa' }), [])
  })

  it('la pantalla tiene el campo Código y lo conserva al filtrar', async () => {
    const r = await new Promise((resolve, reject) => {
      const flashes = []
      const req = { body: {}, params: {}, query: { codigo: cod(pagoA), idCliente: String(cli), preset: 'rango', fechaDesde: '2000-01-01', fechaHasta: '2099-12-31' },
        session: { user }, flash: (t, m) => flashes.push({ t, m }), get: () => null }
      const res = { render: (vista, data) => resolve({ vista, data, flashes }), redirect: (u) => resolve({ url: u, flashes }), json: () => {}, status() { return this } }
      Promise.resolve(TransaccionesController.index(req, res)).catch(reject)
    })
    assert.equal(r.vista, 'pages/transacciones/index', JSON.stringify(r.flashes))
    assert.equal(r.data.movimientos.length, 1)
    const html = await renderVista('pages/transacciones/index', { ...r.data, user })
    assert.match(html, /<label>Código<\/label>/)
    assert.ok(html.includes(`value="${cod(pagoA)}"`))
    assert.ok(html.includes(cod(pagoA)))   // la fila encontrada
  })
})
