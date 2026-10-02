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
})
