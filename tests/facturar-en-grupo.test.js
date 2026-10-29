'use strict'
// Marcar / quitar "para facturar" varias operaciones de una vez (desde Liquidaciones):
// cada una igual que el botón de su detalle (se le suma / descuenta el IVA a lo que debe).
// Corre dentro de la transacción de prueba (ROLLBACK al final: nada queda guardado).
const prueba = require('./helpers/db')
const datos = require('./helpers/datos')
const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const VentasModel = require('../src/models/ventas.model')
const LiquidacionesModel = require('../src/models/liquidaciones.model')
const FacturacionModel = require('../src/models/facturacion.model')
const FacturacionController = require('../src/controllers/facturacion.controller')
const { normalizarFiltros } = require('../src/utils/liquidaciones')
const { hoyISO } = require('../src/utils/fecha')

function llamar(accion, { body = {}, user }) {
  return new Promise((resolve, reject) => {
    const flashes = []
    const req = { body, params: {}, query: {}, session: { user }, flash: (tipo, msg) => flashes.push({ tipo, msg }) }
    const res = { redirect: (url) => resolve({ url, flashes }) }
    Promise.resolve(FacturacionController[accion](req, res)).catch(reject)
  })
}

describe('marcar / quitar para facturar en grupo', () => {
  let admin, producto, user

  before(async () => {
    await prueba.abrir()
    admin = await datos.idAdministrativo()
    user = { id: admin, rol: 'dueno' }
    producto = (await prueba.q(`SELECT id FROM productos WHERE COALESCE(es_contenedor,0)=0 ORDER BY id LIMIT 1`)).rows[0].id
  })
  after(() => prueba.cerrar())

  const venta = async (id_cliente, neto) => {
    const id = (await VentasModel.crear({
      id_cliente, id_administrativo: admin, tipo_op: 'M', modalidad: 'flete', metodo_pago: 'cuenta_corriente',
      fecha_entrega_planificada: '2026-10-05', domicilio: { calle: 'Colón', altura: '100' }, obra: null,
      precio_flete: 0, monto_total: neto, detalles: [{ id_producto: producto, cantidad_pedida: 1, precio_unitario: neto }],
    })).id
    await VentasModel.sincronizarCargoCC(id)
    return id
  }
  const saldo = async (id) => Number((await prueba.q(`SELECT saldo FROM clientes WHERE id = ?`, [id])).rows[0].saldo)
  const marcadas = async (ids) => (await prueba.q(`SELECT id, para_facturar FROM op_encabezado WHERE id = ANY(?::bigint[]) ORDER BY id`, [ids]))
    .rows.map(r => Number(r.para_facturar))

  it('marca varias, les suma el IVA y saltea las que ya estaban', async () => {
    const cli = await datos.crearCliente({ cuentaCorriente: true })
    const a = await venta(cli, 1000)
    const b = await venta(cli, 2000)
    const c = await venta(cli, 3000)
    await FacturacionModel.marcar(c)
    assert.equal(await saldo(cli), -(1000 + 2000 + 3630))

    const cambiadas = await FacturacionModel.marcarVarias([a, b, c])
    assert.deepEqual(cambiadas.map(String), [a, b].map(String))
    assert.deepEqual(await marcadas([a, b, c]), [1, 1, 1])
    assert.equal(await saldo(cli), -(1210 + 2420 + 3630))

    const quitadas = await FacturacionModel.quitarVarias([a, b])
    assert.deepEqual(quitadas.map(String), [a, b].map(String))
    assert.deepEqual(await marcadas([a, b, c]), [0, 0, 1])
    assert.equal(await saldo(cli), -(1000 + 2000 + 3630))
    // Quitar las que no estaban marcadas no hace nada
    assert.deepEqual(await FacturacionModel.quitarVarias([a]), [])
  })

  it('no toca las facturadas', async () => {
    const cli = await datos.crearCliente({ cuentaCorriente: true })
    const a = await venta(cli, 1000)
    await FacturacionModel.marcar(a)
    await prueba.q(`UPDATE op_encabezado SET facturado = 1 WHERE id = ?`, [a])
    assert.deepEqual(await FacturacionModel.quitarVarias([a]), [])
    assert.deepEqual(await marcadas([a]), [1])
  })

  it('controlador: avisa cuántas cambió y vuelve a la liquidación', async () => {
    const cli = await datos.crearCliente({ cuentaCorriente: true })
    const a = await venta(cli, 1000)
    const b = await venta(cli, 2000)
    const volver = `/liquidaciones?clienteId=${cli}&desde=2026-10-01&hasta=2026-10-31`

    let r = await llamar('marcarVarias', { user, body: { ids: [String(a), String(b), 'x'], volver } })
    assert.equal(r.url, volver)
    assert.deepEqual(r.flashes, [{ tipo: 'success', msg: 'Se marcaron 2 operaciones para facturar.' }])

    r = await llamar('marcarVarias', { user, body: { ids: String(a), volver } })
    assert.equal(r.flashes[0].tipo, 'warning')

    r = await llamar('quitarVarias', { user, body: { ids: [String(a)], volver: 'https://otro.sitio' } })
    assert.equal(r.url, '/liquidaciones')
    assert.deepEqual(r.flashes, [{ tipo: 'success', msg: 'Se quitó 1 operación de facturación.' }])

    r = await llamar('marcarVarias', { user, body: {} })
    assert.equal(r.flashes[0].tipo, 'error')
  })

  it('la liquidación dice si cada operación está para facturar', async () => {
    const cli = await datos.crearCliente({ cuentaCorriente: true })
    const a = await venta(cli, 1000)
    const b = await venta(cli, 2000)
    await FacturacionModel.marcarVarias([a])
    const l = await LiquidacionesModel.liquidacion(normalizarFiltros({ clienteId: String(cli), desde: '2026-10-01', hasta: '2026-10-31' }, hoyISO()))
    const ops = Object.fromEntries(l.clientes[0].operaciones.map(o => [String(o.id), o]))
    assert.deepEqual([ops[a].paraFacturar, ops[a].facturado, ops[a].iva], [true, false, 210])
    assert.deepEqual([ops[b].paraFacturar, ops[b].iva], [false, 0])
  })
})
