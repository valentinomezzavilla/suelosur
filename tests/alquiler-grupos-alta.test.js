'use strict'
const prueba = require('./helpers/db')
const datos = require('./helpers/datos')
const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const AlquileresModel = require('../src/models/alquileres.model')

describe('alta de alquileres en el modelo', () => {
  let id_cliente, comunes

  before(async () => {
    await prueba.abrir()
    id_cliente = await datos.crearCliente()
    comunes = datos.datosComunes({ id_cliente, id_administrativo: await datos.idAdministrativo() })
  })
  after(prueba.cerrar)

  const opDe = async (id) => (await prueba.q(`
    SELECT op.estado, op.id_grupo, op.nro_remito, oc.id_contenedor, oc.plazo_alquiler, oc.precio_alquiler,
           (SELECT estado_paso FROM movimiento_contenedor m WHERE m.id_op_contenedor = oc.id ORDER BY m.id DESC LIMIT 1) AS mov
    FROM op_encabezado op JOIN op_detalle_contenedor oc ON oc.id_orden_pedido = op.id WHERE op.id = ?`, [id])).rows[0]
  const contar = async (sql, params) => (await prueba.q(sql, params)).rows[0].n

  it('un contenedor (crear): pendiente, reservado y sin grupo, como siempre', async () => {
    const [cont] = await datos.crearContenedores(1)
    const r = await AlquileresModel.crear({ ...comunes, id_contenedor: cont, plazo_alquiler: 4, precio_alquiler: 100 })
    const op = await opDe(r.id)
    assert.deepEqual([op.estado, op.id_grupo, op.mov], ['pendiente', null, 'pendiente_despacho'])
    assert.deepEqual([op.plazo_alquiler, op.precio_alquiler, op.nro_remito], [4, 100, r.nro_remito])
  })

  it('un contenedor ya en curso (crearEnCurso): entregado y en el domicilio', async () => {
    const [cont] = await datos.crearContenedores(1)
    const r = await AlquileresModel.crearEnCurso({ ...comunes, id_contenedor: cont, plazo_alquiler: null, precio_alquiler: 100 })
    const op = await opDe(r.id)
    assert.deepEqual([op.estado, op.id_grupo, op.mov, op.plazo_alquiler], ['entregado', null, 'en_alquiler', null])
  })

  it('crearGrupo: una OP por contenedor, mismo grupo y remito, precio y plazo propios', async () => {
    const conts = await datos.crearContenedores(2)
    const r = await AlquileresModel.crearGrupo({
      ...comunes, cobro_modo: 'alquiler', en_curso: false,
      contenedores: [
        { id_contenedor: conts[0], plazo_alquiler: 4, precio_alquiler: 100 },
        { id_contenedor: conts[1], plazo_alquiler: 10, precio_alquiler: 150 },
      ],
    })
    assert.equal(r.ops.length, 2)
    assert.ok(r.ops[0].id < r.ops[1].id)
    assert.notEqual(r.ops[0].nro_op, r.ops[1].nro_op)
    const [a, b] = [await opDe(r.ops[0].id), await opDe(r.ops[1].id)]
    assert.deepEqual([a.id_grupo, b.id_grupo], [r.id_grupo, r.id_grupo])
    assert.deepEqual([a.nro_remito, b.nro_remito], [r.nro_remito, r.nro_remito])
    assert.deepEqual([a.estado, b.estado], ['pendiente', 'pendiente'])
    assert.deepEqual([a.mov, b.mov], ['pendiente_despacho', 'pendiente_despacho'])
    assert.deepEqual([a.plazo_alquiler, b.plazo_alquiler], [4, 10])
    assert.deepEqual([a.precio_alquiler, b.precio_alquiler], [100, 150])
    const g = (await prueba.q(`SELECT cobro_modo FROM alquiler_grupos WHERE id = ?`, [r.id_grupo])).rows[0]
    assert.equal(g.cobro_modo, 'alquiler')
  })

  it('crearGrupo ya en curso: todas las OP entregadas y en el domicilio', async () => {
    const conts = await datos.crearContenedores(2)
    const r = await AlquileresModel.crearGrupo({
      ...comunes, cobro_modo: 'contenedor', en_curso: true,
      contenedores: conts.map(id_contenedor => ({ id_contenedor, plazo_alquiler: 4, precio_alquiler: 100 })),
    })
    for (const op of r.ops) {
      const o = await opDe(op.id)
      assert.deepEqual([o.estado, o.mov], ['entregado', 'en_alquiler'])
    }
  })

  it('crearGrupo usa el remito cargado a mano en todas las OP', async () => {
    const conts = await datos.crearContenedores(2)
    const r = await AlquileresModel.crearGrupo({
      ...comunes, cobro_modo: 'contenedor', en_curso: false, nro_remito: 7777777,
      contenedores: conts.map(id_contenedor => ({ id_contenedor, plazo_alquiler: 4, precio_alquiler: 100 })),
    })
    assert.equal(r.nro_remito, 7777777)
    for (const op of r.ops) assert.equal((await opDe(op.id)).nro_remito, 7777777)
  })

  it('crearGrupo con un contenedor ocupado no crea nada y nombra el contenedor', async () => {
    const conts = await datos.crearContenedores(2)
    await AlquileresModel.crear({ ...comunes, id_contenedor: conts[1], plazo_alquiler: 4, precio_alquiler: 100 })
    const numero = (await prueba.q(`SELECT numero_contenedor FROM contenedores WHERE id = ?`, [conts[1]])).rows[0].numero_contenedor
    const opsAntes = await contar(`SELECT COUNT(*)::int n FROM op_encabezado WHERE id_cliente = ?`, [id_cliente])
    const gruposAntes = await contar(`SELECT COUNT(*)::int n FROM alquiler_grupos`)
    await assert.rejects(
      AlquileresModel.crearGrupo({
        ...comunes, cobro_modo: 'contenedor', en_curso: false,
        contenedores: conts.map(id_contenedor => ({ id_contenedor, plazo_alquiler: 4, precio_alquiler: 100 })),
      }),
      new RegExp(`N° ${numero} ya está alquilado`))
    assert.equal(await contar(`SELECT COUNT(*)::int n FROM op_encabezado WHERE id_cliente = ?`, [id_cliente]), opsAntes)
    assert.equal(await contar(`SELECT COUNT(*)::int n FROM alquiler_grupos`), gruposAntes)
  })

  it('crearGrupo rechaza contenedores repetidos y grupos de uno solo', async () => {
    const [cont] = await datos.crearContenedores(1)
    await assert.rejects(AlquileresModel.crearGrupo({ ...comunes, cobro_modo: 'contenedor',
      contenedores: [{ id_contenedor: cont, plazo_alquiler: 4, precio_alquiler: 100 }, { id_contenedor: cont, plazo_alquiler: 4, precio_alquiler: 100 }] }),
      /mismo contenedor más de una vez/)
    await assert.rejects(AlquileresModel.crearGrupo({ ...comunes, cobro_modo: 'contenedor',
      contenedores: [{ id_contenedor: cont, plazo_alquiler: 4, precio_alquiler: 100 }] }),
      /al menos dos contenedores/)
  })
})
