'use strict'
// Un pago de cuenta corriente por transferencia derivada a una estación es UN solo
// movimiento: salda al cliente y baja la deuda con la estación juntos (o ninguno), y el
// mismo formulario enviado dos veces no registra dos pagos (middlewares/envioUnico.js).
// Corre dentro de la transacción de prueba (ROLLBACK al final: nada queda guardado).
const prueba = require('./helpers/db')
const datos = require('./helpers/datos')
const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const ClientesController = require('../src/controllers/clientes.controller')
const EstacionesModel = require('../src/models/estaciones.model')
const envioUnico = require('../src/middlewares/envioUnico')

function llamar(ctrl, accion, { body = {}, params = {}, user }) {
  return new Promise((resolve, reject) => {
    const flashes = []
    const req = { body, params, query: {}, session: { user }, flash: (tipo, msg) => flashes.push({ tipo, msg }), get: () => null }
    const res = { locals: {}, redirect: (url) => resolve({ url, flashes }), render: (vista, data) => resolve({ vista, data, flashes }) }
    Promise.resolve(ctrl[accion](req, res)).catch(reject)
  })
}

// Pasa el pedido por el middleware y, si lo deja seguir, por el controlador
function enviar(accion, { body, params, user }) {
  return new Promise((resolve, reject) => {
    const flashes = []
    const finish = []
    const req = { method: 'POST', body, params, query: {}, session: { user }, flash: (tipo, msg) => flashes.push({ tipo, msg }), get: () => '/volver' }
    const res = {
      locals: {}, statusCode: 302,
      on: (ev, fn) => { if (ev === 'finish') finish.push(fn) },
      redirect: async (url) => {
        // el código se libera si el envío terminó con error
        if (flashes.some(f => f.tipo === 'error')) req.session.flash = { error: flashes.filter(f => f.tipo === 'error').map(f => f.msg) }
        finish.forEach(fn => fn())
        await new Promise(r => setTimeout(r, 20))
        resolve({ url, flashes, controlador: req.llegoAlControlador })
      },
    }
    envioUnico(req, res, () => {
      req.llegoAlControlador = true
      Promise.resolve(ClientesController[accion](req, res)).catch(reject)
    }).catch(reject)
  })
}

describe('pago derivado a una estación: un solo movimiento, sin duplicar', () => {
  let user, estacion

  before(async () => {
    await prueba.abrir()
    user = { id: await datos.idAdministrativo(), rol: 'dueno' }
    estacion = (await prueba.q(`INSERT INTO proveedores (nombre, es_estacion) VALUES ('Shell Prueba Único', 1) RETURNING id`)).rows[0].id
  })
  after(() => prueba.cerrar())

  const pagos = async (cliente) => (await prueba.q(`SELECT * FROM movimientos_cuenta WHERE cliente_id = ? AND tipo = 'pago'`, [cliente])).rows
  const saldoCliente = async (cliente) => Number((await prueba.q(`SELECT saldo FROM clientes WHERE id = ?`, [cliente])).rows[0].saldo)
  const deuda = async () => (await EstacionesModel.cuenta(estacion)).saldo
  const cuerpo = (extra = {}) => ({ monto: '50000', metodo_pago: 'transferencia', tercero: '1', tercero_categoria: 'combustible', tercero_id_proveedor: String(estacion), ...extra })

  it('el pago salda al cliente y baja la deuda con la estación, y dice a quién se transfirió', async () => {
    const cliente = await datos.crearCliente({ cuentaCorriente: true, saldo: -50000 })
    const antes = await deuda()
    await llamar(ClientesController, 'abonar', { user, params: { id: cliente }, body: cuerpo() })
    const p = await pagos(cliente)
    assert.equal(p.length, 1)
    assert.match(p[0].descripcion, /transferido a Shell Prueba Único/)
    assert.equal(await saldoCliente(cliente), 0)
    assert.equal(await deuda(), antes - 50000)
    const e = (await prueba.q(`SELECT * FROM egresos WHERE id_movimiento_cuenta = ?`, [p[0].id])).rows
    assert.equal(e.length, 1)
    assert.equal(Number(e[0].id_proveedor), Number(estacion))
  })

  it('si el egreso al tercero falla, tampoco queda el pago del cliente', async () => {
    const cliente = await datos.crearCliente({ cuentaCorriente: true, saldo: -10000 })
    const r = await llamar(ClientesController, 'registrarMovimiento', { user, params: { id: cliente }, body: {
      clase: 'pago', monto: '10000', metodo_pago: 'transferencia', tercero: '1', tercero_categoria: 'sueldo', tercero_id_empleado: '987654321',
    } })
    assert.ok(r.flashes.some(f => f.tipo === 'error'))
    assert.equal((await pagos(cliente)).length, 0)
    assert.equal(await saldoCliente(cliente), -10000)
  })

  it('el mismo formulario enviado dos veces registra un solo pago', async () => {
    const cliente = await datos.crearCliente({ cuentaCorriente: true, saldo: -100000 })
    const antes = await deuda()
    const token = 'prueba-envio-unico-0001'
    const a = await enviar('abonar', { user, params: { id: cliente }, body: cuerpo({ _envio: token }) })
    const b = await enviar('abonar', { user, params: { id: cliente }, body: cuerpo({ _envio: token }) })
    assert.equal(a.controlador, true)
    assert.notEqual(b.controlador, true)
    assert.equal(b.url, '/volver')
    assert.ok(b.flashes.some(f => f.tipo === 'warning' && /ya se había enviado/.test(f.msg)))
    assert.equal((await pagos(cliente)).length, 1)
    assert.equal(await saldoCliente(cliente), -50000)
    assert.equal(await deuda(), antes - 50000)
  })

  it('con otro código (otro pago real) se registra; si el envío falló, se puede reenviar', async () => {
    const cliente = await datos.crearCliente({ cuentaCorriente: true, saldo: -100000 })
    await enviar('abonar', { user, params: { id: cliente }, body: cuerpo({ _envio: 'prueba-envio-unico-0002' }) })
    await enviar('abonar', { user, params: { id: cliente }, body: cuerpo({ _envio: 'prueba-envio-unico-0003' }) })
    assert.equal((await pagos(cliente)).length, 2)

    const otro = await datos.crearCliente({ cuentaCorriente: true, saldo: -100000 })
    const malo = await enviar('abonar', { user, params: { id: otro }, body: cuerpo({ _envio: 'prueba-envio-unico-0004', tercero_id_proveedor: '' }) })
    assert.ok(malo.flashes.some(f => f.tipo === 'error'))
    const bien = await enviar('abonar', { user, params: { id: otro }, body: cuerpo({ _envio: 'prueba-envio-unico-0004' }) })
    assert.equal(bien.controlador, true)
    assert.equal((await pagos(otro)).length, 1)
  })

  it('sin código o sin sesión, el envío sigue como siempre', async () => {
    let siguio = 0
    await envioUnico({ method: 'POST', body: { a: 1 }, session: { user } }, {}, () => siguio++)
    await envioUnico({ method: 'POST', body: { _envio: 'prueba-envio-unico-0005' }, session: {} }, {}, () => siguio++)
    await envioUnico({ method: 'GET', body: {}, session: { user } }, {}, () => siguio++)
    assert.equal(siguio, 3)
    assert.equal((await prueba.q(`SELECT 1 FROM envios_formulario WHERE token = 'prueba-envio-unico-0005'`)).rows.length, 0)
  })
})
