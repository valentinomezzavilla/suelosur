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
})
