'use strict'
const prueba = require('./helpers/db')
const datos = require('./helpers/datos')
const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { migrarAsignacionPrecio } = require('../src/config/db')
const { SQL_SIGUIENTE_NRO_OP } = require('../src/utils/numeracion')

describe('migración: alquileres sin precio', () => {
  before(prueba.abrir)
  after(prueba.cerrar)

  it('agrega op_detalle_contenedor.precio_asignado_en y se puede correr dos veces', async () => {
    await migrarAsignacionPrecio()
    await migrarAsignacionPrecio()
    const cols = (await prueba.q(`
      SELECT data_type FROM information_schema.columns
      WHERE table_name = 'op_detalle_contenedor' AND column_name = 'precio_asignado_en'`)).rows
    assert.equal(cols.length, 1)
    assert.equal(cols[0].data_type, 'text')
  })

  it('no toca los alquileres existentes: correrla no cambia ninguna fila', async () => {
    const foto = async () => (await prueba.q(`
      SELECT COUNT(*)::int AS filas, COUNT(precio_alquiler)::int AS con_precio, COALESCE(SUM(precio_alquiler), 0) AS suma_precios,
             COUNT(precio_asignado_en)::int AS con_precio_asignado
      FROM op_detalle_contenedor`)).rows[0]
    await migrarAsignacionPrecio() // asegura que la columna exista
    const antes = await foto()
    await migrarAsignacionPrecio()
    assert.deepEqual(await foto(), antes)
  })

  it('precio_alquiler admite NULL (sin precio) y guarda 0 como un precio distinto', async () => {
    const id_cliente = await datos.crearCliente()
    const id_administrativo = await datos.idAdministrativo()
    const { nro } = (await prueba.q(`SELECT ${SQL_SIGUIENTE_NRO_OP} AS nro`)).rows[0]
    const { id: id_op } = (await prueba.q(
      `INSERT INTO op_encabezado (id_cliente, id_administrativo, tipo_op, nro_op, estado) VALUES (?, ?, 'C', ?, 'pendiente') RETURNING id`,
      [id_cliente, id_administrativo, nro])).rows[0]
    const conNull = (await prueba.q(`INSERT INTO op_detalle_contenedor (id_orden_pedido, precio_alquiler) VALUES (?, NULL) RETURNING precio_alquiler`, [id_op])).rows[0]
    const conCero = (await prueba.q(`INSERT INTO op_detalle_contenedor (id_orden_pedido, precio_alquiler) VALUES (?, 0) RETURNING precio_alquiler`, [id_op])).rows[0]
    assert.equal(conNull.precio_alquiler, null)
    assert.equal(conCero.precio_alquiler, 0)
  })
})
