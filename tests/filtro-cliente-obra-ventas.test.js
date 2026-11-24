'use strict'
// Ventas filtra por cliente y por una o varias obras, con el mismo componente que Liquidaciones.
// El filtro llega al listado, a las pestañas por estado y a las tarjetas (regla: los resúmenes
// siguen a la tabla). Corre dentro de la transacción de prueba (ROLLBACK al final).
const prueba = require('./helpers/db')
const datos = require('./helpers/datos')
const { renderVista } = require('./helpers/vistas')
const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const VentasModel = require('../src/models/ventas.model')
const ClientesModel = require('../src/models/clientes.model')
const Ventas = require('../src/controllers/ventas.controller')
const { consulta } = require('../src/utils/consulta')

function llamar(Controller, accion, { query = {}, params = {} } = {}) {
  return new Promise((resolve, reject) => {
    const flashes = []
    const req = { body: {}, params, query, session: { user: { id: 1, rol: 'dueno', nombre: 'Prueba' } }, flash: (t, m) => flashes.push({ t, m }), get: () => '' }
    const res = {
      redirect: (url) => resolve({ url, flashes }),
      render: (vista, data) => resolve({ vista, data, flashes }),
      json: (data) => resolve({ json: data, flashes }),
      status() { return this },
    }
    Promise.resolve(Controller[accion](req, res)).catch(reject)
  })
}
const ids = (ops) => ops.map(o => String(o.id)).sort()
const user = { rol: 'dueno', nombre: 'Prueba' }

// ── Datos: un cliente con tres ventas en tres obras y otro cliente con una venta ─────────
let cliente, otro, opA, opB, opC, opOtro, A, B, C
const rango = { preset: 'rango', fechaDesde: '2026-11-01', fechaHasta: '2026-11-30' }

before(async () => {
  await prueba.abrir()
  const admin = await datos.idAdministrativo()
  cliente = await datos.crearCliente({ cuentaCorriente: true })
  otro = await datos.crearCliente({ cuentaCorriente: true })
  const producto = (await prueba.q(`SELECT id FROM productos WHERE COALESCE(es_contenedor,0)=0 ORDER BY id LIMIT 1`)).rows[0].id
  const venta = async (id_cliente, obra, precio) => String((await VentasModel.crear({ id_cliente, id_administrativo: admin, tipo_op: 'M', modalidad: 'flete',
    fecha_emision: '2026-11-05', fecha_entrega_planificada: '2026-11-05', domicilio: { calle: 'Colón', altura: '100' }, obra,
    metodo_pago: 'efectivo', precio_flete: 0, monto_total: precio,
    detalles: [{ id_producto: producto, cantidad_pedida: 1, precio_unitario: precio }] })).id)
  opA = await venta(cliente, 'Barrio Norte L1', 1000)
  opB = await venta(cliente, 'Barrio Sur L2', 2000)
  opC = await venta(cliente, 'Centro L3', 4000)
  opOtro = await venta(otro, 'Barrio Norte L1', 8000)
  const obras = await ClientesModel.obras(cliente)
  const clave = (nombre) => obras.find(o => o.nombre === nombre).clave
  A = clave('Barrio Norte L1'); B = clave('Barrio Sur L2'); C = clave('Centro L3')
})
after(() => prueba.cerrar())

describe('VentasModel: filtro por operaciones (opIds)', () => {
  it('con opIds lista solo esas operaciones', async () => {
    const r = await VentasModel.listar({ opIds: [opA, opB], limit: 50 })
    assert.deepEqual(ids(r.ops), [opA, opB].sort())
    assert.equal(Number(r.total), 2)
  })

  it('opIds vacío no deja ninguna (no cae a "todas")', async () => {
    const r = await VentasModel.listar({ opIds: [], limit: 50 })
    assert.equal(Number(r.total), 0)
    assert.equal(r.ops.length, 0)
  })

  it('opIds null no filtra: entra también la venta del otro cliente', async () => {
    const r = await VentasModel.listar({ opIds: null, limit: 500 })
    assert.ok(ids(r.ops).includes(opOtro))
    assert.ok(ids(r.ops).includes(opA))
  })

  it('las pestañas por estado y las tarjetas cuentan lo mismo que la tabla', async () => {
    const porEstado = await VentasModel.contarPorEstado({ opIds: [opA] })
    assert.equal(porEstado.reduce((s, r) => s + Number(r.total), 0), 1)
    assert.equal(Number((await VentasModel.resumen({ opIds: [opA, opB] })).count), 2)
  })
})

describe('Ventas: pantalla con cliente y obras', () => {
  it('cliente + dos obras: lista, tarjetas y componente con lo elegido', async () => {
    const { data } = await llamar(Ventas, 'index', { query: { ...rango, clienteId: String(cliente), obra: [A, B] } })
    assert.deepEqual(ids(data.ops), [opA, opB].sort())
    assert.equal(Number(data.metricas.count), 2)
    assert.equal(data.resumen.reduce((s, r) => s + Number(r.total), 0), 2)
    assert.equal(String(data.clienteSel.id), String(cliente))
    assert.equal(data.obras.length, 3)
    assert.deepEqual(data.filtros.obra, [A, B])
    assert.equal(data.filtros.id_cliente, undefined)
  })

  it('solo el cliente: todas sus ventas y ninguna del otro', async () => {
    const { data } = await llamar(Ventas, 'index', { query: { ...rango, clienteId: String(cliente) } })
    assert.deepEqual(ids(data.ops), [opA, opB, opC].sort())
    assert.deepEqual(data.filtros.obra, [])
  })

  it('un enlace viejo con id_cliente sigue filtrando', async () => {
    const { data } = await llamar(Ventas, 'index', { query: { ...rango, id_cliente: String(cliente) } })
    assert.equal(data.filtros.clienteId, String(cliente))
    assert.deepEqual(ids(data.ops), [opA, opB, opC].sort())
  })

  it('un cliente que no existe se ignora (no rompe ni filtra)', async () => {
    const { data } = await llamar(Ventas, 'index', { query: { ...rango, clienteId: '999999999' } })
    assert.equal(data.clienteSel, null)
    assert.equal(data.filtros.clienteId, '')
    assert.ok(ids(data.ops).includes(opOtro) && ids(data.ops).includes(opA))
  })

  it('una obra sin cliente se ignora', async () => {
    const { data } = await llamar(Ventas, 'index', { query: { ...rango, obra: [A] } })
    assert.deepEqual(data.filtros.obra, [])
    assert.ok(ids(data.ops).includes(opOtro))
  })

  it('una obra que ya no existe da lista vacía (no "todas las obras")', async () => {
    const { data } = await llamar(Ventas, 'index', { query: { ...rango, clienteId: String(cliente), obra: ['no existe'] } })
    assert.equal(Number(data.total), 0)
    assert.equal(Number(data.metricas.count), 0)
  })

  it('un clienteId con basura se ignora sin romper', async () => {
    const { data } = await llamar(Ventas, 'index', { query: { ...rango, clienteId: '1;DROP' } })
    assert.equal(data.clienteSel, null)
    assert.equal(data.filtros.clienteId, '')
  })
})

describe('Ventas: la vista usa el componente compartido', () => {
  let html
  before(async () => {
    const { data } = await llamar(Ventas, 'index', { query: { ...rango, clienteId: String(cliente), obra: [A, C] } })
    html = (await renderVista('pages/ventas/index', { ...data, user })).replace(/&amp;/g, '&')
  })

  it('muestra el buscador de cliente y el desplegable de obras con lo elegido', () => {
    assert.ok(html.includes('data-filtro-obras data-dinamico'))
    assert.ok(html.includes(`<input type="hidden" name="clienteId" id="inputClienteId" value="${cliente}">`))
    const marcadas = html.match(/<input type="checkbox" name="obra" value="[^"]*" checked>/g) || []
    assert.deepEqual(marcadas.map(m => m.match(/value="([^"]*)"/)[1]).sort(), [A, C].sort())
  })

  it('ya no tiene el select viejo de clientes', () => {
    assert.ok(!html.includes('name="id_cliente"'))
    assert.ok(!html.includes('data-buscable'))
  })

  it('las pestañas, los períodos y el orden conservan cliente y todas las obras', () => {
    const resto = consulta({ clienteId: String(cliente), obra: [A, C] })
    const href = (re) => (html.match(re) || [])[1]
    assert.ok(href(/href="(\/ventas\?[^"]*estado=pendiente[^"]*)"/).includes(resto), 'pestaña Pendientes')
    assert.ok(href(/href="(\/ventas\?preset=hoy[^"]*)"/).includes(resto), 'chip Hoy')
    assert.ok(href(/href="(\/ventas\?[^"]*sort=nro_op[^"]*)"/).includes(resto), 'orden por Nro. OP')
  })
})
