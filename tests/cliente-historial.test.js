'use strict'
// Ficha del cliente: historial de alquileres y filtro de fechas. Dentro de la transacción de
// prueba (ROLLBACK al final).
const prueba = require('./helpers/db')
const datos = require('./helpers/datos')
const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const ClientesController = require('../src/controllers/clientes.controller')
const VentasModel = require('../src/models/ventas.model')
const TransaccionesModel = require('../src/models/transacciones.model')
const { renderVista } = require('./helpers/vistas')
const { codigo } = require('../src/models/transacciones.model')

function detalle(id, query = {}) {
  return new Promise((resolve, reject) => {
    const flashes = []
    const req = { params: { id: String(id) }, query, session: { user: { rol: 'dueno' } }, flash: (t, m) => flashes.push({ t, m }) }
    const res = { render: (vista, data) => resolve({ vista, data, flashes }), redirect: (url) => resolve({ url, flashes }) }
    Promise.resolve(ClientesController.detalle(req, res)).catch(reject)
  })
}

describe('ficha del cliente: historial de alquileres', () => {
  let cliente, alquiler, venta

  before(async () => {
    await prueba.abrir()
    const admin = await datos.idAdministrativo()
    cliente = await datos.crearCliente()
    const [idCont] = await datos.crearContenedores(1)
    alquiler = (await prueba.q(`
      INSERT INTO op_encabezado (id_cliente, id_administrativo, tipo_op, nro_op, estado, fecha_entrega_planificada, metodo_pago)
      VALUES (?, ?, 'C', 999998, 'pendiente', '2026-09-10', 'efectivo') RETURNING id`, [cliente, admin])).rows[0].id
    await prueba.q(`INSERT INTO op_detalle_contenedor (id_orden_pedido, id_contenedor, domicilio_entrega, precio_alquiler)
      VALUES (?, ?, 'San Martín 55', 150000)`, [alquiler, idCont])
    const producto = (await prueba.q(`SELECT id FROM productos WHERE COALESCE(es_contenedor,0)=0 ORDER BY id LIMIT 1`)).rows[0].id
    venta = (await VentasModel.crear({ id_cliente: cliente, id_administrativo: admin, tipo_op: 'M', modalidad: 'flete', metodo_pago: 'efectivo',
      fecha_entrega_planificada: '2026-10-05', detalles: [{ id_producto: producto, cantidad_pedida: 1, precio_unitario: 100 }] })).id
    await TransaccionesModel.crear({ tipo: 'Venta Viaje', id_op_encabezado: venta, cliente_id: cliente, cliente: 'PRUEBA', monto: 100,
      metodo_pago: 'efectivo', fecha: '2026-10-05' })
  })
  after(() => prueba.cerrar())

  it('sin fechas: lista los alquileres del cliente (no las ventas)', async () => {
    const r = await detalle(cliente)
    assert.equal(r.vista, 'pages/clientes/detalle')
    assert.deepEqual(r.data.alquileres.map(a => String(a.id)), [String(alquiler)])
    assert.equal(r.data.alquileres[0].total, 150000)
    assert.equal(r.data.alquileres[0].estado, 'pendiente')
  })

  it('Desde / Hasta filtran alquileres y transacciones', async () => {
    const octubre = await detalle(cliente, { fechaDesde: '2026-10-01', fechaHasta: '2026-10-31' })
    assert.deepEqual(octubre.data.alquileres, [])
    assert.deepEqual(octubre.data.transacciones.map(t => String(t.id_op_encabezado)), [String(venta)])
    const septiembre = await detalle(cliente, { fechaDesde: '2026-09-01', fechaHasta: '2026-09-30' })
    assert.deepEqual(septiembre.data.alquileres.map(a => String(a.id)), [String(alquiler)])
    assert.deepEqual(septiembre.data.transacciones, [])
  })

  it('fechas mal formadas se ignoran (histórico completo)', async () => {
    const r = await detalle(cliente, { fechaDesde: 'hola', fechaHasta: '2026-99-99' })
    assert.equal(r.data.alquileres.length, 1)
    assert.equal(r.data.transacciones.length, 1)
  })

  it('la vista muestra el alquiler y el link a Liquidaciones', async () => {
    const r = await detalle(cliente)
    const html = await renderVista('pages/clientes/detalle', { ...r.data, codigoTx: codigo })
    assert.match(html, /OP-999998/)
    assert.match(html, /Alquiler contenedor/)
    assert.doesNotMatch(html, /Sin alquileres registrados/)
    assert.match(html, new RegExp(`/liquidaciones\\?clienteId=${cliente}`))
  })
})
