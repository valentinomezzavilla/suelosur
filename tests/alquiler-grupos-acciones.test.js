'use strict'
const prueba = require('./helpers/db')
const datos = require('./helpers/datos')
const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const AlquileresModel = require('../src/models/alquileres.model')
const { llamar } = require('./helpers/controlador')

describe('acciones sobre alquileres agrupados', () => {
  let admin

  before(async () => {
    await prueba.abrir()
    admin = await datos.idAdministrativo()
  })
  after(prueba.cerrar)

  async function grupo({ en_curso = false, cobro_modo = 'contenedor' } = {}) {
    const id_cliente = await datos.crearCliente()
    const conts = await datos.crearContenedores(2)
    const g = await AlquileresModel.crearGrupo({
      ...datos.datosComunes({ id_cliente, id_administrativo: admin, fecha_inicio: '2026-09-28' }),
      cobro_modo, en_curso,
      contenedores: conts.map(id_contenedor => ({ id_contenedor, plazo_alquiler: 4, precio_alquiler: 100 })),
    })
    return { id_cliente, conts, id_grupo: g.id_grupo, ops: g.ops.map(o => o.id) }
  }
  const estados = async (ids) => (await prueba.q(`SELECT estado FROM op_encabezado WHERE id = ANY(?::bigint[]) ORDER BY id`, [ids])).rows.map(r => r.estado)
  const ultimoMov = async (id_contenedor) => (await prueba.q(`SELECT estado_paso FROM movimiento_contenedor WHERE id_contenedor = ? ORDER BY fecha_movimiento DESC, id DESC LIMIT 1`, [id_contenedor])).rows[0].estado_paso

  it('anularGrupo anula las OP pendientes y libera sus contenedores', async () => {
    const g = await grupo()
    assert.equal(await AlquileresModel.anularGrupo(g.ops[0]), 2)
    assert.deepEqual(await estados(g.ops), ['anulado', 'anulado'])
    assert.deepEqual([await ultimoMov(g.conts[0]), await ultimoMov(g.conts[1])], ['disponible', 'disponible'])
  })

  it('anularGrupo no toca las OP ya entregadas', async () => {
    const g = await grupo()
    await AlquileresModel.entregar(g.ops[0])
    assert.equal(await AlquileresModel.anularGrupo(g.ops[1]), 1)
    assert.deepEqual(await estados(g.ops), ['entregado', 'anulado'])
  })

  it('anularGrupo de una OP sin grupo es un error', async () => {
    const id_cliente = await datos.crearCliente()
    const [cont] = await datos.crearContenedores(1)
    const s = await AlquileresModel.crear({ ...datos.datosComunes({ id_cliente, id_administrativo: admin }), id_contenedor: cont, plazo_alquiler: 4, precio_alquiler: 100 })
    await assert.rejects(AlquileresModel.anularGrupo(s.id), /no es de varios contenedores/)
  })

  it('controlador: anular el alquiler completo informa cuántos anuló', async () => {
    const g = await grupo()
    const r = await llamar('anularGrupo', { user: { id: admin, rol: 'dueno' }, params: { id: String(g.ops[0]) } })
    assert.equal(r.url, `/alquileres/contenedores/${g.ops[0]}`)
    assert.deepEqual(r.flashes, [{ tipo: 'success', msg: 'Se anularon 2 contenedores del alquiler.' }])
  })

  it('actualizarCompartidosGrupo copia dirección, obra, zona, pago y observaciones; no plazo ni precio', async () => {
    const g = await grupo()
    await prueba.q(`UPDATE op_detalle_contenedor SET precio_alquiler = 999, plazo_alquiler = 7 WHERE id_orden_pedido = ?`, [g.ops[1]])
    await AlquileresModel.guardarUbicacion(g.ops[1], { lat: -31.4, lng: -64.2, estado: 'ok' })
    await AlquileresModel.actualizar(g.ops[0], {
      calle: 'Av. Colón', numero: '100', zona_entrega: 'Centro', plazo_alquiler: 4, precio_alquiler: 100,
      metodo_pago: 'transferencia', observaciones: 'Nueva obs', fecha_entrega_planificada: '2026-09-28', obra: 'Obra X',
    })
    assert.equal(await AlquileresModel.actualizarCompartidosGrupo(g.ops[0]), 1)
    const op2 = (await prueba.q(`
      SELECT op.metodo_pago, op.observaciones, op.obra, oc.domicilio_calle, oc.domicilio_numero, oc.zona_entrega,
             oc.precio_alquiler, oc.plazo_alquiler, oc.domicilio_lat
      FROM op_encabezado op JOIN op_detalle_contenedor oc ON oc.id_orden_pedido = op.id WHERE op.id = ?`, [g.ops[1]])).rows[0]
    assert.deepEqual(op2, {
      metodo_pago: 'transferencia', observaciones: 'Nueva obs', obra: 'Obra X', domicilio_calle: 'Av. Colón',
      domicilio_numero: '100', zona_entrega: 'Centro', precio_alquiler: 999, plazo_alquiler: 7, domicilio_lat: null,
    })
  })

  it('controlador: editar con "aplicar a todos" actualiza el resto del grupo', async () => {
    const g = await grupo()
    const ubicarOriginal = AlquileresModel.ubicar
    AlquileresModel.ubicar = async () => null // sin Nominatim
    try {
      const r = await llamar('actualizar', { user: { id: admin, rol: 'dueno' }, params: { id: String(g.ops[0]) }, body: {
        calle: 'Otra calle', numero: '5', zona_entrega: '', fechaInicio: '2026-09-28', fechaFin: '2026-10-02',
        precio_alquiler: '100', metodo_pago: 'efectivo', observaciones: '', obra: '', aplicar_grupo: '1',
      } })
      assert.deepEqual(r.flashes, [{ tipo: 'success', msg: 'Alquiler actualizado (y 1 contenedor más del grupo).' }])
    } finally {
      AlquileresModel.ubicar = ubicarOriginal
    }
    const calle = (await prueba.q(`SELECT domicilio_calle FROM op_detalle_contenedor WHERE id_orden_pedido = ?`, [g.ops[1]])).rows[0].domicilio_calle
    assert.equal(calle, 'Otra calle')
  })
})
