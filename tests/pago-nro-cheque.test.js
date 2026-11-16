'use strict'
// "Registrar pago" de la cuenta corriente con Cheque / Echeq: el N° de cheque queda en la
// descripción del pago. Con otro método el número se ignora.
// Corre dentro de la transacción de prueba (ROLLBACK al final: nada queda guardado).
const prueba = require('./helpers/db')
const datos = require('./helpers/datos')
const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const ClientesController = require('../src/controllers/clientes.controller')
const { renderVista } = require('./helpers/vistas')

function abonar(cliente, body, user) {
  return new Promise((resolve, reject) => {
    const flashes = []
    const req = { body, params: { id: cliente }, query: {}, session: { user }, flash: (tipo, msg) => flashes.push({ tipo, msg }), get: () => null }
    const res = { locals: {}, redirect: (url) => resolve({ url, flashes }) }
    Promise.resolve(ClientesController.abonar(req, res)).catch(reject)
  })
}

describe('pago de cuenta corriente con N° de cheque', () => {
  let user

  before(async () => {
    await prueba.abrir()
    user = { id: await datos.idAdministrativo(), rol: 'dueno' }
  })
  after(() => prueba.cerrar())

  const ultimoPago = async (cliente) => (await prueba.q(
    `SELECT * FROM movimientos_cuenta WHERE cliente_id = ? AND tipo = 'pago' ORDER BY id DESC LIMIT 1`, [cliente])).rows[0]

  it('cheque: el número queda en la descripción y el método es cheque', async () => {
    const cliente = await datos.crearCliente({ cuentaCorriente: true, saldo: -5000 })
    const r = await abonar(cliente, { monto: '5000', metodo_pago: 'cheque', nro_cheque: '  00012345 ' }, user)
    assert.ok(r.flashes.some(f => f.tipo === 'success'), JSON.stringify(r.flashes))
    const p = await ultimoPago(cliente)
    assert.equal(p.descripcion, 'Pago / abono de deuda — Cheque N° 00012345')
    assert.equal(p.metodo_pago, 'cheque')
    assert.equal(Number(p.monto), 5000)
  })

  it('echeq, y "Saldar" una operación: concepto + número', async () => {
    const cliente = await datos.crearCliente({ cuentaCorriente: true, saldo: -3000 })
    await abonar(cliente, { monto: '3000', metodo_pago: 'echeq', nro_cheque: '777', descripcion: 'Remito 55' }, user)
    assert.equal((await ultimoPago(cliente)).descripcion, 'Pago — Remito 55 — Echeq N° 777')
  })

  it('sin número, o con otro método, la descripción queda como siempre', async () => {
    const cliente = await datos.crearCliente({ cuentaCorriente: true, saldo: -2000 })
    await abonar(cliente, { monto: '1000', metodo_pago: 'cheque', nro_cheque: '' }, user)
    assert.equal((await ultimoPago(cliente)).descripcion, 'Pago / abono de deuda')
    await abonar(cliente, { monto: '1000', metodo_pago: 'efectivo', nro_cheque: '999' }, user)
    assert.equal((await ultimoPago(cliente)).descripcion, 'Pago / abono de deuda')
  })

  it('el modal trae el campo N° de cheque, oculto y deshabilitado hasta elegir cheque', async () => {
    const html = await renderVista('partials/modal_pago_cuenta', {})
    const grupo = html.match(/<div class="form-group" id="grupoNroChequeAbonar"[^>]*>/)[0]
    assert.match(grupo, /hidden/)
    const input = html.match(/<input[^>]*name="nro_cheque"[^>]*>/)[0]
    assert.match(input, /id="inputNroChequeAbonar"/)
    assert.match(input, /disabled/)
    assert.match(html, /<label for="inputNroChequeAbonar">N° de cheque<\/label>/)
  })
})
