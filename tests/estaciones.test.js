'use strict'
// Estaciones de servicio: proveedores marcados como estación con su cuenta de deuda. Las
// cargas de combustible y los cargos manuales suman; los pagos y las transferencias de
// clientes derivadas a la estación ("Destinado a tercero") restan, una sola vez cada una.
// Corre dentro de la transacción de prueba (ROLLBACK al final: nada queda guardado).
const prueba = require('./helpers/db')
const datos = require('./helpers/datos')
const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const ProveedoresController = require('../src/controllers/proveedores.controller')
const EstacionesController = require('../src/controllers/estaciones.controller')
const ComprasController = require('../src/controllers/compras.controller')
const ClientesController = require('../src/controllers/clientes.controller')
const EstacionesModel = require('../src/models/estaciones.model')
const CombustibleModel = require('../src/models/combustible.model')
const CategoriasEgresoModel = require('../src/models/categoriasEgreso.model')
const TerceroService = require('../src/services/tercero.service')

function llamar(ctrl, accion, { body = {}, params = {}, query = {}, user }) {
  return new Promise((resolve, reject) => {
    const flashes = []
    const req = { body, params, query, session: { user }, flash: (tipo, msg) => flashes.push({ tipo, msg }), get: () => null }
    const res = { locals: {}, redirect: (url) => resolve({ url, flashes }), render: (vista, data) => resolve({ vista, data, flashes }) }
    Promise.resolve(ctrl[accion](req, res)).catch(reject)
  })
}

describe('estaciones de servicio', () => {
  let user, ypf, shell, comun, camion
  const saldo = async (id) => (await EstacionesModel.cuenta(id)).saldo

  before(async () => {
    await prueba.abrir()
    user = { id: await datos.idAdministrativo(), rol: 'dueno' }
    await llamar(ProveedoresController, 'crear', { user, body: { nombre: 'YPF Prueba Ruta 9', es_estacion: '1' } })
    await llamar(ProveedoresController, 'crear', { user, body: { nombre: 'Shell Prueba Centro', es_estacion: '1' } })
    await llamar(ProveedoresController, 'crear', { user, body: { nombre: 'Corralón Prueba' } })
    const id = async (n) => (await prueba.q(`SELECT id FROM proveedores WHERE nombre = ?`, [n])).rows[0].id
    ypf = await id('YPF Prueba Ruta 9'); shell = await id('Shell Prueba Centro'); comun = await id('Corralón Prueba')
    camion = (await prueba.q(`INSERT INTO flota_vehiculos (nombre, patente, tipo_vehiculo) VALUES ('Camión prueba estaciones', 'ZZ999ZZ', 'camion') RETURNING id`)).rows[0].id
  })
  after(() => prueba.cerrar())

  it('solo los proveedores marcados son estaciones; la categoría Combustible pide la estación', async () => {
    const ids = (await EstacionesModel.listar()).map(e => Number(e.id))
    assert.ok(ids.includes(Number(ypf)) && ids.includes(Number(shell)))
    assert.ok(!ids.includes(Number(comun)))
    const comb = await CategoriasEgresoModel.obtenerPorClave('combustible')
    assert.ok(comb.campos.includes('estacion'))
    assert.ok(!comb.campos.includes('proveedor'))
  })

  it('una categoría no puede pedir proveedor y estación a la vez', async () => {
    const idCat = await CategoriasEgresoModel.crear({ etiqueta: 'Gasoil prueba', campos: ['proveedor', 'estacion', 'vehiculo'] })
    assert.deepEqual((await CategoriasEgresoModel.obtener(idCat)).campos, ['estacion', 'vehiculo'])
  })

  it('las cargas de combustible en la estación suman a la deuda', async () => {
    await CombustibleModel.crear({ id_vehiculo: camion, litros: '100', costo_total: '120000', id_proveedor: ypf, fecha: '2026-10-01' })
    await CombustibleModel.crear({ id_vehiculo: camion, litros: '50', costo_total: '60000', id_proveedor: ypf, fecha: '2026-10-05' })
    await CombustibleModel.crear({ id_vehiculo: camion, litros: '10', costo_total: '9999', estacion: 'Otra', fecha: '2026-10-05' })   // sin cuenta
    assert.equal(await saldo(ypf), 180000)
    const c = (await prueba.q(`SELECT estacion FROM combustible WHERE id_proveedor = ? LIMIT 1`, [ypf])).rows[0]
    assert.equal(c.estacion, 'YPF Prueba Ruta 9')
    await assert.rejects(CombustibleModel.crear({ id_vehiculo: camion, litros: '1', costo_total: '1', id_proveedor: comun }), /no existe/)
  })

  it('cargo manual y ajuste a favor; los manuales se pueden borrar', async () => {
    await llamar(EstacionesController, 'agregarMovimiento', { user, params: { id: ypf }, body: { tipo: 'cargo', monto: '20000', descripcion: 'Saldo inicial', fecha: '2026-09-30' } })
    await llamar(EstacionesController, 'agregarMovimiento', { user, params: { id: ypf }, body: { tipo: 'ajuste', monto: '5000', fecha: '2026-10-02' } })
    assert.equal(await saldo(ypf), 195000)
    const ajuste = (await prueba.q(`SELECT id FROM cc_proveedores WHERE id_proveedor = ? AND tipo_movimiento = 'credito'`, [ypf])).rows[0].id
    await llamar(EstacionesController, 'eliminarMovimiento', { user, params: { id: ypf, movId: ajuste } })
    assert.equal(await saldo(ypf), 200000)
  })

  it('transferencia de un cliente derivada a la estación baja la deuda, una sola vez', async () => {
    const t = await TerceroService.leer({ tercero: '1', tercero_categoria: 'combustible', tercero_id_proveedor: String(ypf) }, 'transferencia')
    assert.equal(String(t.id_proveedor), String(ypf))
    const tx = (await prueba.q(`INSERT INTO transacciones (tipo, numero, monto, metodo_pago, cliente) VALUES ('Ajuste', 999001, 50000, 'transferencia', 'Ramos') RETURNING id`)).rows[0].id
    const a = await TerceroService.crearEgreso(t, { monto: 50000, fecha: '2026-10-10', id_transaccion: tx, descripcion: 'Transferencia de Ramos a tercero' })
    const b = await TerceroService.crearEgreso(t, { monto: 50000, fecha: '2026-10-10', id_transaccion: tx, descripcion: 'Transferencia de Ramos a tercero' })
    assert.equal(a, b)
    assert.equal(Number((await prueba.q(`SELECT COUNT(*) AS n FROM egresos WHERE id_transaccion = ?`, [tx])).rows[0].n), 1)
    assert.equal(await saldo(ypf), 150000)
    const mov = (await EstacionesModel.cuenta(ypf)).movimientos.find(m => m.origen === 'transferencia')
    assert.equal(mov.haber, 50000)
  })

  it('pago de cuenta corriente de un cliente derivado a la estación', async () => {
    const cliente = await datos.crearCliente({ cuentaCorriente: true, saldo: -80000 })
    await llamar(ClientesController, 'abonar', { user, params: { id: cliente }, body: {
      monto: '30000', metodo_pago: 'transferencia', tercero: '1', tercero_categoria: 'combustible', tercero_id_proveedor: String(shell),
    } })
    assert.equal(await saldo(shell), -30000)   // sin cargas todavía: queda a favor
    const e = (await prueba.q(`SELECT * FROM egresos WHERE id_proveedor = ? AND origen = 'tercero'`, [shell])).rows
    assert.equal(e.length, 1)
    assert.ok(e[0].id_movimiento_cuenta)
  })

  it('la transferencia a Combustible exige una estación válida', async () => {
    await assert.rejects(TerceroService.leer({ tercero: '1', tercero_categoria: 'combustible' }, 'transferencia'), /estación de servicio/)
    await assert.rejects(TerceroService.leer({ tercero: '1', tercero_categoria: 'combustible', tercero_id_proveedor: String(comun) }, 'transferencia'), /no es válida/)
    const op = await TerceroService.opciones()
    assert.ok(op.estaciones.some(e => Number(e.id) === Number(ypf)))
    assert.ok(!op.estaciones.some(e => Number(e.id) === Number(comun)))
    assert.ok(op.categorias.find(c => c.clave === 'combustible').campos.includes('estacion'))
  })

  it('pago desde la cuenta de la estación y desde Compras / Pagos', async () => {
    const r = await llamar(EstacionesController, 'registrarPago', { user, params: { id: ypf }, body: { monto: '40000', metodo_pago: 'efectivo', fecha: '2026-10-12', descripcion: 'factura 123' } })
    assert.equal(r.url, `/proveedores/estaciones/${ypf}`)
    assert.equal(await saldo(ypf), 110000)
    const e = (await prueba.q(`SELECT * FROM egresos WHERE id_proveedor = ? AND origen = 'manual' ORDER BY id DESC LIMIT 1`, [ypf])).rows[0]
    assert.equal(e.categoria, 'combustible')
    assert.match(e.descripcion, /Pago a YPF Prueba Ruta 9 — factura 123/)

    await llamar(ComprasController, 'crear', { user, body: { categoria: 'combustible', fecha: '2026-10-13', monto: '10000', metodo_pago: 'efectivo', id_proveedor: String(ypf) } })
    assert.equal(await saldo(ypf), 100000)
  })

  it('la cuenta filtrada por fechas arrastra el saldo anterior; el resumen lista la deuda', async () => {
    const c = await EstacionesModel.cuenta(ypf, { desde: '2026-10-05', hasta: '2026-10-10' })
    // Antes del 5/10: cargo 20.000 + carga 120.000 = 140.000
    assert.equal(c.saldoAnterior, 140000)
    assert.deepEqual(c.movimientos.map(m => m.origen), ['carga', 'transferencia'])
    assert.equal(c.movimientos.at(-1).saldo, 150000)
    const r = (await EstacionesModel.resumen()).find(e => Number(e.id) === Number(ypf))
    assert.equal(r.saldo, 100000)
    const v = await llamar(EstacionesController, 'cuenta', { user, params: { id: ypf }, query: { desde: '2026-10-05' } })
    assert.equal(v.vista, 'pages/proveedores/estacion_cuenta')
    assert.equal(v.data.total.saldo, 100000)
    const noEst = await llamar(EstacionesController, 'cuenta', { user, params: { id: comun } })
    assert.equal(noEst.url, '/proveedores/estaciones')
  })
})
