'use strict'
// Las tarjetas de resumen de arriba de cada pantalla tienen que reflejar los MISMOS filtros
// que la tabla de abajo: al filtrar por cliente, fecha, estado, búsqueda, etc. se recalculan.
// Se prueba por el controlador (de ahí salen los datos que ve la pantalla), dentro de la
// transacción de prueba (ROLLBACK al final).
const prueba = require('./helpers/db')
const datos = require('./helpers/datos')
const { renderVista } = require('./helpers/vistas')
const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const VentasModel = require('../src/models/ventas.model')
const ClientesModel = require('../src/models/clientes.model')
const TransaccionesModel = require('../src/models/transacciones.model')
const FacturacionModel = require('../src/models/facturacion.model')
const MovimientosDineroModel = require('../src/models/movimientosDinero.model')
const ContenedoresModel = require('../src/models/contenedores.model')
const FlotaModel = require('../src/models/flota.model')
const ChequesModel = require('../src/models/cheques.model')
const AlertasModel = require('../src/models/alertas.model')
const LiquidacionesModel = require('../src/models/liquidaciones.model')
const { normalizarFiltros } = require('../src/utils/liquidaciones')

// Llama una acción de un controlador con req/res mínimos y devuelve lo que renderiza
function llamar(Controller, accion, { query = {}, params = {}, body = {} } = {}) {
  return new Promise((resolve, reject) => {
    const flashes = []
    const req = { body, params, query, session: { user: { id: 1, rol: 'dueno', nombre: 'Prueba' } }, flash: (t, m) => flashes.push({ t, m }), get: () => '' }
    const res = {
      redirect: (url) => resolve({ url, flashes }),
      render: (vista, data) => resolve({ vista, data, flashes }),
      json: (data) => resolve({ json: data, flashes }),
      status() { return this },
    }
    Promise.resolve(Controller[accion](req, res)).catch(reject)
  })
}
const conteoPor = (filas, campo) => Object.fromEntries(filas.map(f => [f[campo], Number(f.total)]))

// ── Datos comunes ────────────────────────────────────────────────────────────
let admin, producto, clienteA, clienteB
const ventas = {}

before(async () => {
  await prueba.abrir()
  admin = await datos.idAdministrativo()
  producto = (await prueba.q(`SELECT id FROM productos WHERE COALESCE(es_contenedor,0)=0 ORDER BY id LIMIT 1`)).rows[0].id
  clienteA = await datos.crearCliente({ cuentaCorriente: true })
  clienteB = await datos.crearCliente({ cuentaCorriente: true })
  const base = { id_administrativo: admin, tipo_op: 'M', modalidad: 'flete', domicilio: { calle: 'Colón', altura: '100' }, obra: null }
  const nueva = async (cliente, fecha, extra = {}) => (await VentasModel.crear({
    ...base, id_cliente: cliente, fecha_emision: fecha, fecha_entrega_planificada: fecha, metodo_pago: 'efectivo',
    precio_flete: 0, monto_total: 1000, detalles: [{ id_producto: producto, cantidad_pedida: 1, precio_unitario: 1000 }], ...extra,
  })).id
  const estado = (id, e) => prueba.q(`UPDATE op_encabezado SET estado = ? WHERE id = ?`, [e, id])
  // Cliente A: dos pendientes (una con texto buscable) y una entregada. Cliente B: una pendiente y una anulada.
  ventas.a1 = await nueva(clienteA, '2026-10-05', { observaciones: 'RESFILTRO-XYZ' })
  ventas.a2 = await nueva(clienteA, '2026-10-20')
  ventas.a3 = await nueva(clienteA, '2026-10-06'); await estado(ventas.a3, 'entregado')
  ventas.b1 = await nueva(clienteB, '2026-10-07')
  ventas.b2 = await nueva(clienteB, '2026-10-08'); await estado(ventas.b2, 'anulado')
  // Las de A se marcan para facturar (Facturación)
  for (const id of [ventas.a1, ventas.a2]) await FacturacionModel.marcarAlCrear(id, '1', 1000)
  await FacturacionModel.marcarAlCrear(ventas.b1, '1', 1000)
})
after(() => prueba.cerrar())

// ── Ventas: las pestañas por estado ──────────────────────────────────────────
describe('Ventas: contadores por estado', () => {
  const Ventas = require('../src/controllers/ventas.controller')
  const rango = { preset: 'rango', fechaDesde: '2026-10-01', fechaHasta: '2026-10-31' }
  const contar = async (query) => conteoPor((await llamar(Ventas, 'index', { query: { ...rango, ...query } })).data.resumen, 'estado')

  it('con un cliente, cuenta solo sus ventas', async () => {
    assert.deepEqual(await contar({ id_cliente: String(clienteA) }), { pendiente: 2, entregado: 1 })
    assert.deepEqual(await contar({ id_cliente: String(clienteB) }), { pendiente: 1, anulado: 1 })
  })
  it('con fechas, cuenta solo las de ese período', async () => {
    assert.deepEqual(await contar({ id_cliente: String(clienteA), fechaHasta: '2026-10-10' }), { pendiente: 1, entregado: 1 })
    assert.deepEqual(await contar({ id_cliente: String(clienteA), fechaDesde: '2026-10-15' }), { pendiente: 1 })
  })
  it('con la búsqueda, cuenta solo lo que coincide', async () => {
    assert.deepEqual(await contar({ id_cliente: String(clienteA), q: 'RESFILTRO-XYZ' }), { pendiente: 1 })
  })
  it('el filtro de estado no cambia las tarjetas (cada una es una pestaña)', async () => {
    assert.deepEqual(await contar({ id_cliente: String(clienteA), estado: 'entregado' }), { pendiente: 2, entregado: 1 })
  })
  it('las métricas de abajo siguen el estado elegido y las tarjetas no', async () => {
    const { data } = await llamar(Ventas, 'index', { query: { ...rango, id_cliente: String(clienteA), estado: 'pendiente' } })
    assert.equal(Number(data.metricas.count), 2)
    assert.equal(Number(data.metricas.total), 2420)   // dos de $1.000 marcadas "para facturar": llevan el IVA (21 %) sumado
  })
})

// ── Cheques ──────────────────────────────────────────────────────────────────
describe('Cheques: tarjetas según los filtros', () => {
  const Cheques = require('../src/controllers/cheques.controller')
  before(async () => {
    const cheque = (cartera, estado, monto, numero) => prueba.q(
      `INSERT INTO cheques (tipo_cartera, estado, monto, numero, tipo) VALUES (?, ?, ?, ?, 'fisico')`, [cartera, estado, monto, numero])
    await cheque('recibido', 'en_espera', 1000, 'RESFILT-1')
    await cheque('recibido', 'habilitado', 500, 'RESFILT-2')
    await cheque('emitido', 'en_espera', 300, 'RESFILT-3')
  })
  const resumen = async (query) => (await llamar(Cheques, 'index', { query: { q: 'RESFILT', ...query } })).data.resumen

  it('con la búsqueda, suma solo los cheques que coinciden', async () => {
    const r = await resumen({})
    assert.equal(r.recibido.total, 1500); assert.equal(r.recibido.en_espera, 1000); assert.equal(r.emitido.total, 300)
  })
  it('con la cartera elegida, la otra queda en cero', async () => {
    const r = await resumen({ tipo_cartera: 'recibido' })
    assert.equal(r.recibido.total, 1500); assert.equal(r.emitido.total, 0)
  })
  it('con el estado elegido, suma solo ese estado', async () => {
    const r = await resumen({ estado: 'en_espera' })
    assert.equal(r.recibido.total, 1000); assert.equal(r.emitido.total, 300)
  })
  it('sin filtros incluye todo (las tarjetas no se rompen)', async () => {
    const r = await ChequesModel.resumen()
    assert.ok(r.recibido.total >= 1500 && r.emitido.total >= 300)
  })
})

// ── Flota ────────────────────────────────────────────────────────────────────
describe('Flota: tarjetas según los filtros', () => {
  const Flota = require('../src/controllers/flota.controller')
  before(async () => {
    const camion = (patente, marca, estado, activo = 1) => prueba.q(
      `INSERT INTO flota_vehiculos (tipo_vehiculo, patente, nombre, marca, estado_operativo, activo) VALUES ('camion', ?, ?, ?, ?, ?)`,
      [patente, 'Camión ' + patente, marca, estado, activo])
    await camion('RES001', 'MARCARES', 'disponible')
    await camion('RES002', 'MARCARES', 'disponible')
    await camion('RES003', 'MARCARES', 'en_mantenimiento')
    await camion('RES004', 'MARCARES', 'disponible', 0)   // dado de baja: no cuenta
    await camion('OTR001', 'OTRAMARCA', 'fuera_servicio')
  })
  const resumen = async (query) => (await llamar(Flota, 'index', { query })).data.resumen

  it('con una marca, cuenta solo esos camiones activos', async () => {
    const r = await resumen({ marca: 'MARCARES' })
    assert.equal(r.total, 3); assert.equal(r.porEstado.disponible, 2); assert.equal(r.porEstado.en_mantenimiento, 1)
  })
  it('con el estado, cuenta solo ese estado', async () => {
    const r = await resumen({ marca: 'MARCARES', estado: 'disponible' })
    assert.equal(r.total, 2); assert.equal(r.porEstado.en_mantenimiento, undefined)
  })
  it('con la búsqueda por patente', async () => {
    const r = await resumen({ q: 'RES003' })
    assert.equal(r.total, 1); assert.equal(r.porEstado.en_mantenimiento, 1)
  })
  it('sin filtros cuenta toda la flota activa (lo que usa el Dashboard)', async () => {
    const r = await FlotaModel.resumenFlota()
    assert.ok(r.total >= 4)
    assert.ok(r.porEstado.fuera_servicio >= 1)
  })
})

// ── Alertas ──────────────────────────────────────────────────────────────────
describe('Alertas: tarjetas según los filtros', () => {
  const Alertas = require('../src/controllers/alertas.controller')
  before(async () => {
    await prueba.q(`INSERT INTO empleados (nombre, apellido, activo, es_chofer, licencia_vencimiento) VALUES ('Alerta', 'Prueba', 1, 1, '2000-01-01')`)
  })
  const resumen = async (query) => (await llamar(Alertas, 'index', { query })).data.resumen

  it('con el módulo, cuenta solo las alertas de ese módulo', async () => {
    const ch = await resumen({ modulo: 'choferes' }), fl = await resumen({ modulo: 'flota' }), todas = await resumen({})
    assert.ok(ch.vencido >= 1)
    assert.equal(ch.total + fl.total, todas.total)
    assert.equal(fl.total, (await AlertasModel.listar({ modulo: 'flota' })).length)
  })
  it('con la severidad, las demás quedan en cero', async () => {
    const r = await resumen({ severidad: 'vencido' })
    assert.ok(r.vencido >= 1); assert.equal(r.critico + r.alto + r.medio, 0); assert.equal(r.total, r.vencido)
  })
  it('con el tipo', async () => {
    const r = await resumen({ modulo: 'choferes', tipo: 'licencia' })
    assert.equal(r.total, (await AlertasModel.listar({ modulo: 'choferes', tipo: 'licencia' })).length)
  })
})

// ── Facturación ──────────────────────────────────────────────────────────────
describe('Facturación: KPIs según los filtros', () => {
  const Facturacion = require('../src/controllers/facturacion.controller')
  const pendiente = async (query) => (await llamar(Facturacion, 'index', { query })).data.resumen.pendiente

  it('con un cliente, cuenta solo lo suyo', async () => {
    const a = await pendiente({ clienteId: String(clienteA) })
    assert.equal(a.count, 2); assert.equal(a.total, 2420)   // $1.000 + 21 % de IVA cada una
    assert.equal((await pendiente({ clienteId: String(clienteB) })).count, 1)
  })
  it('con fechas, cuenta solo las operaciones de ese período', async () => {
    assert.equal((await pendiente({ clienteId: String(clienteA), desde: '2026-10-10', hasta: '2026-10-31' })).count, 1)
    assert.equal((await pendiente({ clienteId: String(clienteA), desde: '2026-12-01' })).count, 0)
  })
  it('con el tipo de operación', async () => {
    assert.equal((await pendiente({ clienteId: String(clienteA), tipo: 'viaje' })).count, 2)
    assert.equal((await pendiente({ clienteId: String(clienteA), tipo: 'contenedor' })).count, 0)
  })
  it('con la búsqueda por N° de OP', async () => {
    const nro = (await prueba.q(`SELECT nro_op FROM op_encabezado WHERE id = ?`, [ventas.a1])).rows[0].nro_op
    assert.equal((await pendiente({ q: 'OP-' + String(nro).padStart(4, '0') })).count, 1)
  })
})

// ── Contenedores ─────────────────────────────────────────────────────────────
describe('Contenedores: tarjetas según los filtros', () => {
  const Contenedores = require('../src/controllers/contenedores.controller')
  let n1, n2
  before(async () => {
    const [c1, c2] = await datos.crearContenedores(2)
    n1 = (await prueba.q(`SELECT numero_contenedor FROM contenedores WHERE id = ?`, [c1])).rows[0].numero_contenedor
    n2 = (await prueba.q(`SELECT numero_contenedor FROM contenedores WHERE id = ?`, [c2])).rows[0].numero_contenedor
    await prueba.q(`UPDATE contenedores SET estado_general = 'en_reparacion' WHERE id = ?`, [c2])
  })

  it('con la búsqueda, cuenta solo ese contenedor', async () => {
    assert.deepEqual(conteoPor(await ContenedoresModel.resumenPorEstado({ q: String(n1) }), 'estado_paso'), { disponible: 1 })
  })
  it('con la condición general', async () => {
    assert.deepEqual(conteoPor(await ContenedoresModel.resumenPorEstado({ estado_general: 'en_reparacion', q: String(n2) }), 'estado_paso'), { disponible: 1 })
    assert.deepEqual(await ContenedoresModel.resumenPorEstado({ estado_general: 'en_reparacion', q: String(n1) }), [])
  })
  it('el estado elegido no cambia las tarjetas (cada una es ese filtro)', async () => {
    const { data } = await llamar(Contenedores, 'index', { query: { q: String(n1), estado_paso: 'en_alquiler' } })
    assert.deepEqual(conteoPor(data.resumen, 'estado_paso'), { disponible: 1 })
  })
  it('sin filtros cuenta todos los activos', async () => {
    assert.ok(conteoPor(await ContenedoresModel.resumenPorEstado(), 'estado_paso').disponible >= 2)
  })
  it('al hacer clic en una tarjeta se conservan los otros filtros', async () => {
    const { data } = await llamar(Contenedores, 'index', { query: { q: String(n1), estado_general: 'operativo' } })
    const html = await renderVista('pages/contenedores/index', data)
    assert.match(html, new RegExp(`href="/contenedores\\?estado_paso=disponible&amp;q=${n1}&amp;estado_general=operativo"`))
  })
})

// ── Cuenta corriente (estado de cuenta del cliente): tarjetas de operaciones ──
describe('Cuenta corriente del cliente: tarjetas de operaciones según todos los filtros', () => {
  const Clientes = require('../src/controllers/clientes.controller')
  let contado, cc, contenedor
  before(async () => {
    const cli = await datos.crearCliente({ cuentaCorriente: true })
    const base = { id_cliente: cli, id_administrativo: admin, tipo_op: 'M', modalidad: 'flete',
      fecha_emision: '2026-10-05', fecha_entrega_planificada: '2026-10-05', domicilio: { calle: 'Colón', altura: '100' }, obra: null }
    // Contado cobrado: 1200
    contado = (await VentasModel.crear({ ...base, metodo_pago: 'efectivo', precio_flete: 200, monto_total: 1200,
      detalles: [{ id_producto: producto, cantidad_pedida: 2, precio_unitario: 500 }] })).id
    await TransaccionesModel.crear({ tipo: 'Venta Viaje', id_op_encabezado: contado, cliente_id: cli, cliente: 'PRUEBA', monto: 1200,
      descripcion: 'prueba', metodo_pago: 'efectivo', fecha: '2026-10-05' })
    // Cuenta corriente: 900 con 400 pagados (parcial, resta 500)
    cc = (await VentasModel.crear({ ...base, metodo_pago: 'cuenta_corriente', precio_flete: 0, monto_total: 900,
      detalles: [{ id_producto: producto, cantidad_pedida: 1, precio_unitario: 1000 }] })).id
    await VentasModel.sincronizarCargoCC(cc)
    await ClientesModel.agregarMovimiento(cli, { tipo: 'pago', descripcion: 'Pago prueba', monto: 400, metodo_pago: 'transferencia' })
    // Alquiler de contenedor sin precio (a convenir)
    const [idCont] = await datos.crearContenedores(1)
    contenedor = (await prueba.q(`INSERT INTO op_encabezado (id_cliente, id_administrativo, tipo_op, nro_op, estado, fecha_entrega_planificada)
      VALUES (?, ?, 'C', 999998, 'pendiente', '2026-10-04') RETURNING id`, [cli, admin])).rows[0].id
    await prueba.q(`INSERT INTO op_detalle_contenedor (id_orden_pedido, id_contenedor, domicilio_entrega, precio_alquiler) VALUES (?, ?, 'San Martín 55', NULL)`, [contenedor, idCont])
    ventas.cliCC = cli
  })
  const tarjetas = async (query) => (await llamar(Clientes, 'cuentaDetalle', {
    params: { id: String(ventas.cliCC) }, query: { desde: '2026-10-01', hasta: '2026-10-31', ...query } })).data.resumenOps

  it('sin más filtros suma todas las operaciones del período', async () => {
    assert.deepEqual(await tarjetas({}), { consumido: 2100, pagado: 1600, saldo: 500, cantidad: 3 })
  })
  it('con "solo pendientes" cuenta solo lo que todavía se debe (las "a convenir" no)', async () => {
    assert.deepEqual(await tarjetas({ estadoPago: 'pendientes' }), { consumido: 900, pagado: 400, saldo: 500, cantidad: 1 })
  })
  it('con "solo pagadas"', async () => {
    assert.deepEqual(await tarjetas({ estadoPago: 'pagadas' }), { consumido: 1200, pagado: 1200, saldo: 0, cantidad: 1 })
  })
  it('con el tipo de operación', async () => {
    assert.equal((await tarjetas({ tipos: ['viaje'] })).cantidad, 2)
    assert.equal((await tarjetas({ tipos: ['contenedor'] })).cantidad, 1)
  })
  it('con fechas fuera de las operaciones queda en cero', async () => {
    assert.deepEqual(await tarjetas({ desde: '2026-12-01', hasta: '2026-12-31' }), { consumido: 0, pagado: 0, saldo: 0, cantidad: 0 })
  })
  it('coincide con la Liquidación del cliente (mismo cálculo que el PDF)', async () => {
    const f = normalizarFiltros({ clienteId: String(ventas.cliCC), desde: '2026-10-01', hasta: '2026-10-31', estadoPago: 'pendientes' }, '2026-10-31')
    assert.deepEqual(await tarjetas({ estadoPago: 'pendientes' }), (await LiquidacionesModel.liquidacion(f)).resumen)
  })
  it('la pantalla muestra las tarjetas', async () => {
    const { data } = await llamar(Clientes, 'cuentaDetalle', { params: { id: String(ventas.cliCC) }, query: { desde: '2026-10-01', hasta: '2026-10-31', estadoPago: 'pendientes' } })
    const html = await renderVista('pages/clientes/cuenta_detalle', data)
    assert.match(html, /Pendiente de estas operaciones<\/span><strong class="text-danger">\$500<\/strong>/)
    assert.match(html, /Operaciones<\/span><strong>1<\/strong>/)
  })
})

// ── Los que ya seguían los filtros: que no se rompan ─────────────────────────
describe('Transacciones y Liquidaciones: las tarjetas siguen los filtros', () => {
  it('Transacciones: lo que entró depende del cliente y las fechas', async () => {
    const dineroCliente = async (cliente, extra = {}) => (await MovimientosDineroModel.resumen({ clienteId: cliente, categoria: 'ventas', fechaDesde: '2026-10-01', fechaHasta: '2026-10-31', ...extra }))
    const a = await dineroCliente(ventas.cliCC)
    assert.equal(a.entradas, 1200)
    assert.equal((await dineroCliente(clienteB)).entradas, 0)
    assert.equal((await dineroCliente(ventas.cliCC, { fechaDesde: '2025-01-01', fechaHasta: '2025-12-31' })).entradas, 0)
  })
  it('Liquidaciones: el resumen sigue el estado de pago', async () => {
    const f = (extra) => normalizarFiltros({ clienteId: String(ventas.cliCC), desde: '2026-10-01', hasta: '2026-10-31', ...extra }, '2026-10-31')
    assert.equal((await LiquidacionesModel.liquidacion(f({}))).resumen.cantidad, 3)
    assert.equal((await LiquidacionesModel.liquidacion(f({ estadoPago: 'pagadas' }))).resumen.cantidad, 1)
  })
})
