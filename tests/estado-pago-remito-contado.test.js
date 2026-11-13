'use strict'
// Marcar pendiente un remito (continuación): "solo esta operación", remito cobrado de contado
// (por el controlador, con su mensaje) y remito mixto (cuenta corriente + contado), que se bloquea.
// Corre dentro de la transacción de prueba (ROLLBACK al final).
const prueba = require('./helpers/db')
const datos = require('./helpers/datos')
const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const EstadoPago = require('../src/models/estadoPago.model')
const EstadoPagoController = require('../src/controllers/estadoPago.controller')
const ClientesModel = require('../src/models/clientes.model')
const VentasModel = require('../src/models/ventas.model')
const TransaccionesModel = require('../src/models/transacciones.model')
const LiquidacionesModel = require('../src/models/liquidaciones.model')
const { normalizarFiltros } = require('../src/utils/liquidaciones')

function llamar(accion, { params = {}, body = {}, query = {} }) {
  return new Promise((resolve, reject) => {
    const flashes = []
    const req = { params, body, query, session: { user: { id: 1, rol: 'dueno' } }, flash: (t, m) => flashes.push({ t, m }) }
    const res = { redirect: (url) => resolve({ url, flashes }), json: (d) => resolve({ json: d, flashes }), status() { return this } }
    Promise.resolve(EstadoPagoController[accion](req, res)).catch(reject)
  })
}

describe('marcar pendiente un remito: solo esta operación, contado y mixto', () => {
  let admin, producto
  before(async () => {
    await prueba.abrir()
    admin = await datos.idAdministrativo()
    producto = (await prueba.q(`SELECT id FROM productos WHERE COALESCE(es_contenedor,0)=0 ORDER BY id LIMIT 1`)).rows[0].id
  })
  after(() => prueba.cerrar())

  const venta = async (cliente, fecha, neto, remito, metodo = 'cuenta_corriente') => {
    const id = (await VentasModel.crear({
      id_cliente: cliente, id_administrativo: admin, tipo_op: 'M', modalidad: 'deposito', metodo_pago: metodo,
      fecha_emision: fecha, monto_total: neto, nro_remito: remito, detalles: [{ id_producto: producto, cantidad_pedida: 1, precio_unitario: neto }],
    })).id
    if (metodo === 'cuenta_corriente') await VentasModel.sincronizarCargoCC(id)
    return id
  }
  const cobrar = async (cliente, id, monto) => {
    await prueba.q(`UPDATE op_encabezado SET estado = 'entregado' WHERE id = ?`, [id])
    await TransaccionesModel.crear({ tipo: 'Venta Cantera', id_op_encabezado: id, cliente_id: cliente, monto, metodo_pago: 'efectivo' })
  }
  const estados = async (cliente) => Object.fromEntries((await LiquidacionesModel.liquidacion(
    normalizarFiltros({ clienteId: String(cliente), desde: '2000-01-01', hasta: '2099-12-31' }, '2026-11-13'))).clientes[0].operaciones.map(o => [String(o.id), o.estado]))
  const saldo = async (id) => Number((await prueba.q(`SELECT saldo FROM clientes WHERE id = ?`, [id])).rows[0].saldo)

  it('"solo esta operación": deja pendiente únicamente la elegida y la otra del remito sigue pagada', async () => {
    const cli = await datos.crearCliente({ cuentaCorriente: true })
    const R1 = await venta(cli, '2026-10-14', 200000, 8101)
    const R2 = await venta(cli, '2026-10-15', 150000, 8101)
    const p = await ClientesModel.agregarMovimiento(cli, { tipo: 'pago', descripcion: 'Pago', monto: 350000, metodo_pago: 'echeq', fecha: '2026-11-11 12:00:00' })
    await ClientesModel.guardarImputaciones(p, [])
    assert.deepEqual(await estados(cli), { [R1]: 'pagada', [R2]: 'pagada' })

    // Por defecto se marcaría el remito completo
    assert.equal((await EstadoPago.vistaPreviaPendiente(R1)).operaciones.length, 2)
    // Con soloEsta (también por el controlador): una
    const previa = (await llamar('vistaPrevia', { params: { id: R1 }, query: { accion: 'pendiente', soloEsta: '1' } })).json
    assert.equal(previa.puede, true)
    assert.equal(previa.operaciones.length, 1)
    assert.equal(previa.resumen.quitado, 200000)

    await llamar('marcarPendiente', { params: { id: R1 }, body: { motivo: 'Solo esta', soloEsta: '1' } })
    assert.deepEqual(await estados(cli), { [R1]: 'pendiente', [R2]: 'pagada' })
    assert.equal(await saldo(cli), -200000)
  })

  it('remito cobrado de contado con dos operaciones: las dos pasan a cuenta corriente y el mensaje lo dice', async () => {
    const cli = await datos.crearCliente({ cuentaCorriente: true })
    const A = await venta(cli, '2026-10-14', 120000, 8102, 'efectivo')
    const B = await venta(cli, '2026-10-14', 80000, 8102, 'efectivo')
    await cobrar(cli, A, 120000); await cobrar(cli, B, 80000)
    assert.deepEqual(await estados(cli), { [A]: 'pagada', [B]: 'pagada' })

    const previa = await EstadoPago.vistaPreviaPendiente(A)
    assert.equal(previa.camino, 'contado')
    assert.equal(previa.puede, true)
    assert.equal(previa.resumen.quitado, 200000)
    assert.equal(previa.operaciones.length, 2)

    const r = await llamar('marcarPendiente', { params: { id: A }, body: { motivo: 'No pagó' } })
    assert.match(r.flashes[0].m, /^El remito 8102: 2 operaciones \(OP-\d{4}, OP-\d{4}\) quedaron pendientes de pago\./)
    assert.deepEqual(await estados(cli), { [A]: 'pendiente', [B]: 'pendiente' })
    assert.equal(await saldo(cli), -200000)
  })

  it('remito mixto (una en cuenta corriente y otra cobrada de contado): se bloquea y se ofrece marcar solo una', async () => {
    const cli = await datos.crearCliente({ cuentaCorriente: true })
    const M1 = await venta(cli, '2026-10-14', 60000, 8103)                        // cuenta corriente
    const M2 = await venta(cli, '2026-10-14', 40000, 8103, 'efectivo')            // contado
    await cobrar(cli, M2, 40000)
    const elegidas = await ClientesModel.validarImputaciones(cli, [{ clave: `op:${M1}`, monto: 60000 }], 60000)   // se valida ANTES de registrar el pago
    const p = await ClientesModel.agregarMovimiento(cli, { tipo: 'pago', descripcion: 'Pago', monto: 60000, metodo_pago: 'transferencia', fecha: '2026-11-11 12:00:00' })
    await ClientesModel.guardarImputaciones(p, elegidas)
    assert.deepEqual(await estados(cli), { [M1]: 'pagada', [M2]: 'pagada' })

    const previa = await EstadoPago.vistaPreviaPendiente(M1)
    assert.equal(previa.puede, false)
    assert.equal(previa.opsDelRemito, 2)                         // la ventana ofrece "Marcar solo esta operación"
    assert.match(previa.bloqueos[0], /distinta forma/)
    await assert.rejects(() => EstadoPago.marcarPendiente(M1, { usuario: admin, motivo: 'prueba' }), /distinta forma/)
    assert.deepEqual(await estados(cli), { [M1]: 'pagada', [M2]: 'pagada' })

    // Solo esta operación sí se puede, y la de contado no se toca
    await EstadoPago.marcarPendiente(M1, { usuario: admin, motivo: 'prueba', soloEsta: true })
    assert.deepEqual(await estados(cli), { [M1]: 'pendiente', [M2]: 'pagada' })
    assert.equal(await saldo(cli), -60000)
  })

  it('la ventana: lista las operaciones, avisa que las demás no cambian y ofrece "solo esta operación" si algo lo impide', () => {
    const fs = require('fs'), path = require('path')
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'estadoPago.js'), 'utf8')
    assert.match(js, /operaciones de este remito/)
    assert.match(js, /no cambian: siguen con el mismo estado y el mismo saldo/)
    assert.match(js, /soloEstaBtn\.hidden = !\(r\.opsDelRemito > 1 && !actual\.soloEsta\)/)
    assert.match(js, /&soloEsta=1/)
    const partial = fs.readFileSync(path.join(__dirname, '..', 'views', 'partials', 'modal_estado_pago.ejs'), 'utf8')
    for (const id of ['estadoPagoOps', 'estadoPagoOtras', 'estadoPagoSoloEsta', 'estadoPagoSoloEstaCampo']) assert.match(partial, new RegExp(`id="${id}"`))
  })
})
