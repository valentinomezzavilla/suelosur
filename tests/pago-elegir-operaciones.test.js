'use strict'
// Pago de la cuenta corriente eligiendo qué operaciones paga ("Registrar pago" / "Saldar").
// Lo elegido manda en todos los módulos; lo que no se elige va a las deudas más antiguas.
// Corre dentro de la transacción de prueba (ROLLBACK al final: nada queda guardado).
const prueba = require('./helpers/db')
const datos = require('./helpers/datos')
const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { imputar, porOperacion } = require('../src/utils/imputacion')
const ClientesModel = require('../src/models/clientes.model')
const ClientesController = require('../src/controllers/clientes.controller')
const LiquidacionesModel = require('../src/models/liquidaciones.model')
const VentasModel = require('../src/models/ventas.model')
const TransaccionesModel = require('../src/models/transacciones.model')
const { normalizarFiltros } = require('../src/utils/liquidaciones')
const { hoyISO } = require('../src/utils/fecha')
const { renderVista } = require('./helpers/vistas')

const mov = (id, monto, extra = {}) => ({ id, monto, tipo: monto < 0 ? 'deuda' : 'pago', id_op_encabezado: null, ...extra })

describe('imputación con operaciones elegidas', () => {
  it('el pago va a la operación elegida aunque haya deudas más viejas', () => {
    const movs = [mov(1, -1000, { id_op_encabezado: 10 }), mov(2, -1000, { id_op_encabezado: 20 }), mov(3, 1000)]
    const { cargos, aFavor, aplicaciones } = imputar(movs, [{ id_pago: 3, id_op_encabezado: 20, monto: 1000 }])
    assert.equal(cargos[1].restante, 1000)
    assert.equal(cargos[2].restante, 0)
    assert.equal(aFavor, 0)
    assert.deepEqual(aplicaciones[3], [{ idCargo: 2, idOp: 20, monto: 1000, elegida: true }])
  })

  it('lo que no se eligió va a lo más viejo y lo que sobra queda a favor', () => {
    const movs = [mov(1, -1000, { id_op_encabezado: 10 }), mov(2, -1000, { id_op_encabezado: 20 }), mov(3, 1700)]
    const { cargos, aFavor } = imputar(movs, [{ id_pago: 3, id_op_encabezado: 20, monto: 500 }])
    // 500 a la elegida; el resto (1200) a lo más viejo que se deba: la primera entera y lo que
    // le falta a la elegida
    assert.equal(cargos[1].restante, 0)
    assert.equal(cargos[2].restante, 300)
    assert.equal(aFavor, 0)
    const r = imputar([...movs, mov(4, 600)], [{ id_pago: 3, id_op_encabezado: 20, monto: 500 }])
    assert.equal(r.cargos[2].restante, 0)
    assert.equal(r.aFavor, 300)            // …y lo que sobra, a favor
  })

  it('una operación con varios cargos (IVA) se paga entera; lo elegido de más se reparte', () => {
    const movs = [mov(1, -1000, { id_op_encabezado: 10 }), mov(2, -210, { id_op_encabezado: 10 }), mov(3, -500, { id_op_encabezado: 20 }), mov(4, 1500)]
    const { cargos } = imputar(movs, [{ id_pago: 4, id_op_encabezado: 10, monto: 1500 }])
    assert.deepEqual([cargos[1].restante, cargos[2].restante, cargos[3].restante], [0, 0, 210])
    assert.deepEqual(porOperacion(cargos)[10], { total: 1210, pagado: 1210 })
  })

  it('un cargo a mano se elige por su id; lo de un pago anulado no cuenta', () => {
    const movs = [mov(1, -300), mov(2, -400), mov(3, 400)]
    assert.equal(imputar(movs, [{ id_pago: 3, id_cargo: 2, monto: 400 }]).cargos[2].restante, 0)
    // El pago 9 no está (anulado): su elección se ignora
    const r = imputar(movs, [{ id_pago: 9, id_cargo: 1, monto: 300 }])
    assert.deepEqual([r.cargos[1].restante, r.cargos[2].restante], [0, 300])
  })

  it('invariante: lo que falta de los cargos menos lo a favor = la deuda de la cuenta', () => {
    const movs = [mov(1, -300, { id_op_encabezado: 1 }), mov(2, 50), mov(3, -200, { id_op_encabezado: 2 }), mov(4, 900),
      mov(5, -80, { tipo: 'uso_saldo_favor', id_op_encabezado: 3 }), mov(6, -60), mov(7, 20, { tipo: 'ajuste', id_op_encabezado: 2 })]
    const { cargos, aFavor } = imputar(movs, [{ id_pago: 4, id_op_encabezado: 2, monto: 150 }, { id_pago: 4, id_cargo: 6, monto: 60 }])
    const restante = Object.values(cargos).reduce((s, c) => s + c.restante, 0)
    assert.equal(Math.round((restante - aFavor) * 100) / 100, -movs.reduce((s, m) => s + m.monto, 0))
  })
})

describe('registrar un pago eligiendo las operaciones', () => {
  let admin, user, producto
  const HOY = hoyISO()

  before(async () => {
    await prueba.abrir()
    admin = await datos.idAdministrativo()
    user = { id: admin, rol: 'dueno' }
    producto = (await prueba.q(`SELECT id FROM productos WHERE COALESCE(es_contenedor,0)=0 ORDER BY id LIMIT 1`)).rows[0].id
  })
  after(() => prueba.cerrar())

  function llamar(accion, { body = {}, params = {}, query = {} }) {
    return new Promise((resolve, reject) => {
      const flashes = []
      const req = { body, params, query, baseUrl: '', session: { user }, flash: (tipo, msg) => flashes.push({ tipo, msg }), get: () => null }
      const res = {
        redirect: (url) => resolve({ url, flashes }), render: (vista, data) => resolve({ vista, data, flashes }),
        json: (data) => resolve({ json: data, flashes }), status() { return this },
      }
      Promise.resolve(ClientesController[accion](req, res)).catch(reject)
    })
  }
  const ventaCC = async (cliente, compra, neto) => {
    const id = (await VentasModel.crear({
      id_cliente: cliente, id_administrativo: admin, tipo_op: 'M', modalidad: 'deposito', metodo_pago: 'cuenta_corriente',
      fecha_emision: compra, monto_total: neto, detalles: [{ id_producto: producto, cantidad_pedida: 1, precio_unitario: neto }],
    })).id
    await VentasModel.sincronizarCargoCC(id)
    return id
  }
  const opsLiq = async (cliente) => Object.fromEntries((await LiquidacionesModel.liquidacion(
    normalizarFiltros({ clienteId: String(cliente), desde: '2000-01-01', hasta: '2099-12-31' }, HOY))).clientes[0].operaciones.map(o => [String(o.id), o]))
  const saldo = async (id) => Number((await prueba.q(`SELECT saldo FROM clientes WHERE id = ?`, [id])).rows[0].saldo)
  const pagar = (cliente, monto, imputaciones, extra = {}) => llamar('abonar', { params: { id: cliente }, body: {
    monto: String(monto), metodo_pago: 'transferencia', fecha: HOY, imputaciones: JSON.stringify(imputaciones), ...extra } })

  it('consumió $1.500.000 y entrega $1.000.000 para las dos más nuevas: esas quedan pagadas, la vieja pendiente', async () => {
    const cli = await datos.crearCliente({ cuentaCorriente: true })
    const v1 = await ventaCC(cli, '2026-09-10', 500000)
    const v2 = await ventaCC(cli, '2026-10-10', 500000)
    const v3 = await ventaCC(cli, '2026-11-02', 500000)
    const r = await pagar(cli, 1000000, [{ clave: `op:${v3}`, monto: 500000 }, { clave: `op:${v2}`, monto: 500000 }])
    assert.ok(!r.flashes.some(f => f.tipo === 'error'), JSON.stringify(r.flashes))
    const ops = await opsLiq(cli)
    assert.deepEqual([ops[v1].estado, ops[v2].estado, ops[v3].estado], ['pendiente', 'pagada', 'pagada'])
    assert.equal(await saldo(cli), -500000)
    // Lo mismo en Ventas / Transacciones (venta saldada) y en el estado de cuenta
    assert.deepEqual(await ClientesModel.saldadaPorOperacion([v1, v2, v3]), { [v1]: false, [v2]: true, [v3]: true })
    const api = await llamar('pendientesApi', { params: { id: cli } })
    assert.deepEqual(api.json.pendientes.map(p => [p.clave, p.resta]), [[`op:${v1}`, 500000]])
  })

  it('"Saldar" una operación: el monto exacto que le falta y se aplica a ella', async () => {
    const cli = await datos.crearCliente({ cuentaCorriente: true })
    const v1 = await ventaCC(cli, '2026-09-10', 300000)
    const v2 = await ventaCC(cli, '2026-10-10', 450000)
    await pagar(cli, 100000, [{ clave: `op:${v2}`, monto: 100000 }])   // un pago parcial de la nueva
    const api = await llamar('pendientesApi', { params: { id: cli } })
    const item = api.json.pendientes.find(p => p.clave === `op:${v2}`)
    assert.equal(item.resta, 350000)
    assert.equal(item.total, 450000)
    await pagar(cli, item.resta, [{ clave: item.clave, monto: item.resta }], { descripcion: 'Venta Cantera OP' })
    const ops = await opsLiq(cli)
    assert.equal(ops[v2].estado, 'pagada')
    assert.equal(ops[v1].estado, 'pendiente') // la vieja no se tocó
    assert.equal(ops[v1].resta, 300000)
  })

  it('sin elegir: como siempre, a lo más viejo', async () => {
    const cli = await datos.crearCliente({ cuentaCorriente: true })
    const v1 = await ventaCC(cli, '2026-09-10', 300000)
    const v2 = await ventaCC(cli, '2026-10-10', 300000)
    await pagar(cli, 300000, [])
    const ops = await opsLiq(cli)
    assert.deepEqual([ops[v1].estado, ops[v2].estado], ['pagada', 'pendiente'])
  })

  it('no se registra si lo elegido no cierra (más que el pago, más que la deuda o sin deuda)', async () => {
    const cli = await datos.crearCliente({ cuentaCorriente: true })
    const v1 = await ventaCC(cli, '2026-09-10', 300000)
    const v2 = await ventaCC(cli, '2026-10-10', 300000)
    const pagos = async () => (await prueba.q(`SELECT 1 FROM movimientos_cuenta WHERE cliente_id = ? AND tipo = 'pago'`, [cli])).rowCount
    let r = await pagar(cli, 100000, [{ clave: `op:${v1}`, monto: 80000 }, { clave: `op:${v2}`, monto: 80000 }])
    assert.match(r.flashes.find(f => f.tipo === 'error').msg, /es más que el pago/)
    r = await pagar(cli, 400000, [{ clave: `op:${v1}`, monto: 400000 }])
    assert.match(r.flashes.find(f => f.tipo === 'error').msg, /le aplicaste \$400\.000 y debe \$300\.000/)
    r = await pagar(cli, 1000, [{ clave: 'op:999999999', monto: 1000 }])
    assert.match(r.flashes.find(f => f.tipo === 'error').msg, /ya no tiene deuda/)
    assert.equal(await pagos(), 0)
    assert.equal(await saldo(cli), -600000)
  })

  it('anular el pago: las operaciones que pagaba vuelven a quedar pendientes', async () => {
    const cli = await datos.crearCliente({ cuentaCorriente: true })
    const v1 = await ventaCC(cli, '2026-09-10', 200000)
    const v2 = await ventaCC(cli, '2026-10-10', 200000)
    await pagar(cli, 200000, [{ clave: `op:${v2}`, monto: 200000 }])
    const pago = (await prueba.q(`SELECT id FROM movimientos_cuenta WHERE cliente_id = ? AND tipo = 'pago'`, [cli])).rows[0].id
    assert.equal((await opsLiq(cli))[v2].estado, 'pagada')
    await ClientesModel.anularPago(pago, cli, { usuario: admin, motivo: 'prueba' })
    const ops = await opsLiq(cli)
    assert.deepEqual([ops[v1].estado, ops[v2].estado], ['pendiente', 'pendiente'])
  })

  it('borrar una operación pagada con un pago elegido no falla y el pago queda a favor', async () => {
    const cli = await datos.crearCliente({ cuentaCorriente: true })
    const v1 = await ventaCC(cli, '2026-10-10', 150000)
    await pagar(cli, 150000, [{ clave: `op:${v1}`, monto: 150000 }])
    const tx = await TransaccionesModel.crear({ tipo: 'Venta Cantera', id_op_encabezado: v1, cliente_id: cli, monto: 150000, metodo_pago: 'cuenta_corriente' })
    await TransaccionesModel.eliminar(tx)
    assert.equal(await saldo(cli), 150000)
    assert.equal((await prueba.q(`SELECT 1 FROM imputaciones_pago WHERE id_op_encabezado = ?`, [v1])).rowCount, 0)
  })

  it('el estado de cuenta muestra "Saldar" por operación y a qué se aplicó cada pago', async () => {
    const cli = await datos.crearCliente({ cuentaCorriente: true })
    const v1 = await ventaCC(cli, '2026-10-05', 300000)
    const v2 = await ventaCC(cli, '2026-10-20', 300000)
    await pagar(cli, 350000, [{ clave: `op:${v2}`, monto: 300000 }])
    const r = await llamar('cuentaDetalle', { params: { id: cli }, query: { desde: '2026-10-01' } })
    assert.equal(r.vista, 'pages/clientes/cuenta_detalle', JSON.stringify(r))
    const nro = (await prueba.q(`SELECT nro_op FROM op_encabezado WHERE id = ?`, [v2])).rows[0].nro_op
    const nro1 = (await prueba.q(`SELECT nro_op FROM op_encabezado WHERE id = ?`, [v1])).rows[0].nro_op
    const html = await renderVista('pages/clientes/cuenta_detalle', { ...r.data, user })
    assert.match(html, new RegExp(`data-clave="op:${v1}"\\s+data-deuda="250000"`))
    assert.doesNotMatch(html, new RegExp(`data-clave="op:${v2}"`))
    assert.match(html, new RegExp(`Aplicado a: OP-${String(nro).padStart(4, '0')} \\$300\\.000 · OP-${String(nro1).padStart(4, '0')} \\$50\\.000`))
    assert.match(html, /id="pagoOperaciones"/) // el modal con la elección de operaciones
  })
})
