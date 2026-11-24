'use strict'
// Filtro de cliente y obras compartido por Ventas, Transacciones, Facturación y el Libro:
// helper de enlaces (consulta), selección de cliente + obras en el servidor y enlaces de
// orden/paginación con varias obras. Corre dentro de la transacción de prueba (ROLLBACK).
const prueba = require('./helpers/db')
const datos = require('./helpers/datos')
const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const VentasModel = require('../src/models/ventas.model')
const ClientesModel = require('../src/models/clientes.model')
const Facturacion = require('../src/controllers/facturacion.controller')
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

// ── Datos comunes: un cliente con tres obras y otro cliente con una venta ───────────────
let cliente, otro, opA, opB, opC, A, B, C

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
  await venta(otro, 'Barrio Norte L1', 8000)
  const obras = await ClientesModel.obras(cliente)
  const clave = (nombre) => obras.find(o => o.nombre === nombre).clave
  A = clave('Barrio Norte L1'); B = clave('Barrio Sur L2'); C = clave('Centro L3')
})
after(() => prueba.cerrar())

describe('consulta(obj)', () => {
  it('omite vacíos y repite el parámetro de las listas', () => {
    assert.equal(consulta({ a: '1', b: '', c: null, d: undefined, obra: ['x y', 'z'], vacia: [] }), 'a=1&obra=x+y&obra=z')
  })
  it('conserva el 0 y saca los vacíos de una lista', () => {
    assert.equal(consulta({ n: 0, obra: ['', 'a', null] }), 'n=0&obra=a')
  })
})

describe('ClientesModel.seleccionFiltro', () => {
  it('cliente + dos obras: sus operaciones, todas las obras del cliente y las claves', async () => {
    const sel = await ClientesModel.seleccionFiltro(String(cliente), [A, B])
    assert.equal(String(sel.clienteSel.id), String(cliente))
    assert.equal(sel.obras.length, 3)
    assert.deepEqual(sel.opIds.slice().sort(), [opA, opB].sort())
    assert.deepEqual(sel.claves, [A, B])
  })

  it('sin obra elegida: opIds null, claves vacías y la lista de obras igual', async () => {
    const sel = await ClientesModel.seleccionFiltro(String(cliente), undefined)
    assert.equal(sel.opIds, null)
    assert.equal(sel.obra, null)
    assert.deepEqual(sel.claves, [])
    assert.equal(sel.obras.length, 3)
  })

  it('cliente inexistente o con formato inválido: todo vacío', async () => {
    for (const id of ['999999999', 'abc', '', undefined, '1; DROP TABLE x']) {
      assert.deepEqual(await ClientesModel.seleccionFiltro(id, [A]),
        { clienteSel: null, obras: [], obra: null, opIds: null, claves: [] }, `clienteId ${JSON.stringify(id)}`)
    }
  })

  it('una obra que ya no existe: opIds vacío (no cae a "todas")', async () => {
    const sel = await ClientesModel.seleccionFiltro(String(cliente), ['no existe'])
    assert.deepEqual(sel.opIds, [])
  })
})

// Facturación usa el mismo helper (prueba de caracterización: su comportamiento no cambia)
describe('Facturación: cliente y obras elegidos', () => {
  it('con cliente y dos obras: lo deja elegido y trae todas sus obras para el desplegable', async () => {
    const { data } = await llamar(Facturacion, 'index', { query: { clienteId: String(cliente), obra: [A, B] } })
    assert.equal(String(data.clienteSel.id), String(cliente))
    assert.equal(data.obras.length, 3)
    assert.deepEqual(data.filtros.obra, [A, B])
  })

  it('un cliente que no existe se ignora y limpia las obras', async () => {
    const { data } = await llamar(Facturacion, 'index', { query: { clienteId: '999999999', obra: ['x'] } })
    assert.equal(data.clienteSel, null)
    assert.equal(data.filtros.clienteId, '')
    assert.deepEqual(data.filtros.obra, [])
  })
})
