'use strict'
const prueba = require('./helpers/db')
const datos = require('./helpers/datos')
const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const TransaccionesModel = require('../src/models/transacciones.model')
const VentasModel = require('../src/models/ventas.model')

describe('filtro por N° de operación', () => {
  it('entiende 308, 0308 y OP-0308', () => {
    for (const t of ['308', '0308', 'OP-0308', 'op 308', ' OP-308 ']) assert.equal(TransaccionesModel.nroOpDeTexto(t), 308)
  })
  it('vacío o sin números = sin filtro', () => {
    for (const t of ['', '   ', 'OP-', 'abc', undefined, null]) assert.equal(TransaccionesModel.nroOpDeTexto(t), null)
  })
  it('_filtro agrega la condición por nro_op de la operación', () => {
    const { where, params } = TransaccionesModel._filtro({ nroOp: 'OP-0308' })
    assert.match(where, /id_op_encabezado IN \(SELECT id FROM op_encabezado WHERE nro_op = \?\)/)
    assert.deepEqual(params, [308])
  })
  it('_filtro sin nroOp válido no cambia nada', () => {
    assert.deepEqual(TransaccionesModel._filtro({ nroOp: 'abc' }), { where: '', params: [] })
  })
})

describe('filtro por N° de operación contra la base', () => {
  let nroOp, idOp
  before(async () => {
    await prueba.abrir()
    const cliente = await datos.crearCliente()
    const admin = await datos.idAdministrativo()
    const producto = (await prueba.q(`SELECT id FROM productos WHERE COALESCE(es_contenedor,0)=0 ORDER BY id LIMIT 1`)).rows[0].id
    const r = await VentasModel.crear({ id_cliente: cliente, id_administrativo: admin, tipo_op: 'M', modalidad: 'flete', metodo_pago: 'efectivo',
      detalles: [{ id_producto: producto, cantidad_pedida: 1, precio_unitario: 100 }] })
    idOp = r.id; nroOp = r.nro_op
    await TransaccionesModel.crear({ tipo: 'Venta Viaje', id_op_encabezado: idOp, cliente_id: cliente, cliente: 'PRUEBA', monto: 100, metodo_pago: 'efectivo' })
  })
  after(() => prueba.cerrar())

  it('encuentra la transacción de esa operación', async () => {
    const r = await TransaccionesModel.filtrar({ nroOp: `OP-${String(nroOp).padStart(4, '0')}`, limit: 50 })
    assert.equal(r.rows.length, 1)
    assert.equal(String(r.rows[0].id_op_encabezado), String(idOp))
  })
})
