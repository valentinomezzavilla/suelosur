'use strict'
const prueba = require('./helpers/db')
const datos = require('./helpers/datos')
const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const AlquileresModel = require('../src/models/alquileres.model')
const { llamar } = require('./helpers/controlador')
const { hoyISO } = require('../src/utils/fecha')
const { sumarDiasHabiles } = require('../src/utils/diasHabiles')

describe('controlador de alquileres: alta', () => {
  let admin
  const inicio = sumarDiasHabiles(hoyISO(), 3) // a futuro: alta normal, no "ya en curso"

  before(async () => {
    await prueba.abrir()
    admin = { id: await datos.idAdministrativo(), rol: 'dueno' }
    AlquileresModel.ubicar = async () => null // sin llamadas a Nominatim en las pruebas
  })
  after(prueba.cerrar)

  const opsDe = async (id_cliente) => (await prueba.q(`
    SELECT op.id, op.nro_op, op.id_grupo, op.estado, oc.plazo_alquiler, oc.precio_alquiler, oc.id_contenedor
    FROM op_encabezado op JOIN op_detalle_contenedor oc ON oc.id_orden_pedido = op.id
    WHERE op.id_cliente = ? ORDER BY op.id`, [id_cliente])).rows

  const cuerpo = (extra) => ({
    calle: 'San Lorenzo', numero: '501', fechaInicio: inicio, fechaFin: sumarDiasHabiles(inicio, 4),
    precio_alquiler: '100', metodoPago: 'efectivo', ...extra,
  })

  it('un contenedor, sin cuenta corriente: plazo estándar aunque se edite el fin', async () => {
    const id_cliente = await datos.crearCliente()
    const [cont] = await datos.crearContenedores(1)
    const r = await llamar('crear', { user: admin, body: cuerpo({
      clienteId: String(id_cliente), id_contenedor: String(cont),
      editar_fecha_fin: '1', fechaFin: sumarDiasHabiles(inicio, 9),
    }) })
    assert.equal(r.url, '/alquileres/contenedores')
    const [op] = await opsDe(id_cliente)
    assert.equal(op.plazo_alquiler, 4)
    assert.equal(op.id_grupo, null)
  })

  it('un contenedor, con cuenta corriente y fin a mano: cuenta los días hábiles', async () => {
    const id_cliente = await datos.crearCliente({ cuentaCorriente: true })
    const [cont] = await datos.crearContenedores(1)
    await llamar('crear', { user: admin, body: cuerpo({
      clienteId: String(id_cliente), id_contenedor: String(cont),
      editar_fecha_fin: '1', fechaFin: sumarDiasHabiles(inicio, 7),
    }) })
    const [op] = await opsDe(id_cliente)
    assert.equal(op.plazo_alquiler, 7)
  })

  it('fin anterior al inicio vuelve al formulario con el error', async () => {
    const id_cliente = await datos.crearCliente({ cuentaCorriente: true })
    const [cont] = await datos.crearContenedores(1)
    const r = await llamar('crear', { user: admin, body: cuerpo({
      clienteId: String(id_cliente), id_contenedor: String(cont), editar_fecha_fin: '1', fechaFin: '2020-01-01',
    }) })
    assert.equal(r.url, '/alquileres/contenedores/nuevo')
    assert.deepEqual(r.flashes, [{ tipo: 'error', msg: 'La fecha de fin no puede ser anterior a la de inicio.' }])
  })

  it('varios contenedores: un grupo, precio y fin propios, cobro elegido', async () => {
    const id_cliente = await datos.crearCliente({ cuentaCorriente: true })
    const [c1, c2] = await datos.crearContenedores(2)
    const r = await llamar('crear', { user: admin, body: cuerpo({
      clienteId: String(id_cliente),
      ids_contenedor: [String(c1), String(c2)],
      precio_c: { ['c' + c2]: '150' },
      fin_c: { ['c' + c2]: sumarDiasHabiles(inicio, 7) },
      cobro_modo: 'alquiler',
    }) })
    assert.equal(r.url, '/alquileres/contenedores')
    assert.equal(r.flashes[0].tipo, 'success')
    assert.match(r.flashes[0].msg, /Alquiler de 2 contenedores creado: OP-\d{4}, OP-\d{4}\. Cobro por alquiler\./)
    const ops = await opsDe(id_cliente)
    assert.equal(ops.length, 2)
    assert.ok(ops[0].id_grupo)
    assert.equal(ops[0].id_grupo, ops[1].id_grupo)
    assert.deepEqual(ops.map(o => o.precio_alquiler), [100, 150])
    assert.deepEqual(ops.map(o => o.plazo_alquiler), [10, 7]) // cuenta corriente: 10 por defecto; el segundo, a mano
    const g = (await prueba.q(`SELECT cobro_modo FROM alquiler_grupos WHERE id = ?`, [ops[0].id_grupo])).rows[0]
    assert.equal(g.cobro_modo, 'alquiler')
  })

  it('varios contenedores con fecha de inicio pasada: se cargan como en curso', async () => {
    const id_cliente = await datos.crearCliente()
    const [c1, c2] = await datos.crearContenedores(2)
    const r = await llamar('crear', { user: admin, body: cuerpo({
      clienteId: String(id_cliente), fechaInicio: '2026-09-28', fechaFin: sumarDiasHabiles('2026-09-28', 4),
      ids_contenedor: [String(c1), String(c2)],
    }) })
    assert.match(r.flashes[0].msg, /cargado como en curso/)
    assert.deepEqual((await opsDe(id_cliente)).map(o => o.estado), ['entregado', 'entregado'])
  })

  it('varios contenedores en carga histórica: error, es de a uno', async () => {
    const id_cliente = await datos.crearCliente()
    const [c1, c2] = await datos.crearContenedores(2)
    const r = await llamar('crear', { user: admin, body: cuerpo({
      clienteId: String(id_cliente), finalizado: '1', ids_contenedor: [String(c1), String(c2)],
    }) })
    assert.equal(r.url, '/alquileres/contenedores/nuevo')
    assert.deepEqual(r.flashes, [{ tipo: 'error', msg: 'La carga histórica es de a un contenedor por alquiler.' }])
    assert.equal((await opsDe(id_cliente)).length, 0)
  })

  it('varios contenedores con un precio en cero: error y no se crea nada', async () => {
    const id_cliente = await datos.crearCliente()
    const [c1, c2] = await datos.crearContenedores(2)
    const r = await llamar('crear', { user: admin, body: cuerpo({
      clienteId: String(id_cliente), ids_contenedor: [String(c1), String(c2)], precio_c: { ['c' + c1]: '0' },
    }) })
    assert.deepEqual(r.flashes, [{ tipo: 'error', msg: 'Revisá el precio de cada contenedor: tiene que ser mayor a cero.' }])
    assert.equal((await opsDe(id_cliente)).length, 0)
  })
})
