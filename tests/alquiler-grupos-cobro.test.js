'use strict'
const prueba = require('./helpers/db')
const datos = require('./helpers/datos')
const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const AlquileresModel = require('../src/models/alquileres.model')
const { llamar } = require('./helpers/controlador')
const TransaccionesModel = require('../src/models/transacciones.model')
const ClientesModel = require('../src/models/clientes.model')

describe('cobro de alquileres agrupados', () => {
  let admin

  before(async () => {
    await prueba.abrir()
    admin = await datos.idAdministrativo()
  })
  after(prueba.cerrar)

  // Grupo ya en curso (contenedores en el domicilio), listo para retirar.
  async function grupoEnCurso({ cobro_modo, metodo_pago = 'efectivo', cuentaCorriente = false, en_curso = true }) {
    const id_cliente = await datos.crearCliente({ cuentaCorriente })
    const conts = await datos.crearContenedores(2)
    const g = await AlquileresModel.crearGrupo({
      ...datos.datosComunes({ id_cliente, id_administrativo: admin, metodo_pago, fecha_inicio: '2026-09-28' }),
      cobro_modo, en_curso,
      contenedores: conts.map(id_contenedor => ({ id_contenedor, plazo_alquiler: 4, precio_alquiler: 100 })),
    })
    return { id_cliente, conts, id_grupo: g.id_grupo, ops: g.ops.map(o => o.id) }
  }
  const retirar = (id) => AlquileresModel.devolverAPlanta(id)
  const txDe = async (id) => (await prueba.q(`SELECT monto, metodo_pago FROM transacciones WHERE id_op_encabezado = ? ORDER BY id`, [id])).rows
  const movsDe = async (id_cliente) => (await prueba.q(`SELECT tipo, monto, id_op_encabezado FROM movimientos_cuenta WHERE cliente_id = ? ORDER BY id`, [id_cliente])).rows
  const saldoDe = async (id_cliente) => (await prueba.q(`SELECT saldo FROM clientes WHERE id = ?`, [id_cliente])).rows[0].saldo
  const precioCierre = async (id) => (await AlquileresModel.datosCierre(id)).precioActual

  it('un contenedor sin grupo: se cobra al retirarlo, como siempre', async () => {
    const id_cliente = await datos.crearCliente()
    const [cont] = await datos.crearContenedores(1)
    const r = await AlquileresModel.crearEnCurso({ ...datos.datosComunes({ id_cliente, id_administrativo: admin, fecha_inicio: '2026-09-28' }), id_contenedor: cont, plazo_alquiler: 4, precio_alquiler: 100 })
    await retirar(r.id)
    const esperado = await precioCierre(r.id)
    assert.equal(await AlquileresModel.cobrarAlCerrar(r.id), esperado)
    assert.equal((await txDe(r.id)).length, 1)
  })

  it('por contenedor: cada OP se cobra al retirarla', async () => {
    const g = await grupoEnCurso({ cobro_modo: 'contenedor', metodo_pago: 'cuenta_corriente', cuentaCorriente: true })
    await retirar(g.ops[0])
    assert.equal(await AlquileresModel.cobrarAlCerrar(g.ops[0]), await precioCierre(g.ops[0]))
    assert.deepEqual([(await txDe(g.ops[0])).length, (await txDe(g.ops[1])).length], [1, 0])
    await retirar(g.ops[1])
    assert.equal(await AlquileresModel.cobrarAlCerrar(g.ops[1]), await precioCierre(g.ops[1]))
    assert.equal((await movsDe(g.id_cliente)).length, 2) // un cargo por contenedor
  })

  it('por alquiler: no cobra hasta el último; después una transacción por OP y un solo cargo por el total', async () => {
    const g = await grupoEnCurso({ cobro_modo: 'alquiler', metodo_pago: 'cuenta_corriente', cuentaCorriente: true })
    await retirar(g.ops[0])
    assert.equal(await AlquileresModel.cobrarAlCerrar(g.ops[0]), null)
    assert.deepEqual([(await txDe(g.ops[0])).length, (await movsDe(g.id_cliente)).length], [0, 0])
    await retirar(g.ops[1])
    const total = (await precioCierre(g.ops[0])) + 1500
    assert.equal(await AlquileresModel.cobrarAlCerrar(g.ops[1], '1500'), total)
    assert.equal((await txDe(g.ops[0])).length, 1)
    assert.deepEqual((await txDe(g.ops[1])).map(t => t.monto), [1500])
    const movs = await movsDe(g.id_cliente)
    assert.deepEqual(movs.map(m => [m.tipo, m.monto, m.id_op_encabezado]), [['deuda', -total, g.ops[0]]])
    assert.equal(await saldoDe(g.id_cliente), -total)
  })

  it('por alquiler: cobrar dos veces no duplica nada', async () => {
    const g = await grupoEnCurso({ cobro_modo: 'alquiler', metodo_pago: 'cuenta_corriente', cuentaCorriente: true })
    await retirar(g.ops[0]); await retirar(g.ops[1])
    assert.notEqual(await AlquileresModel.cobrarAlCerrar(g.ops[1]), null)
    assert.equal(await AlquileresModel.cobrarAlCerrar(g.ops[1]), null)
    assert.equal(await AlquileresModel.cobrarGrupo(g.id_grupo), null)
    assert.deepEqual([(await txDe(g.ops[0])).length, (await txDe(g.ops[1])).length, (await movsDe(g.id_cliente)).length], [1, 1, 1])
  })

  it('por alquiler "a convenir": sin método queda pendiente; con método se cobra el grupo entero', async () => {
    const g = await grupoEnCurso({ cobro_modo: 'alquiler', metodo_pago: 'a_convenir' })
    await retirar(g.ops[0]); await retirar(g.ops[1])
    assert.equal(await AlquileresModel.cobrarAlCerrar(g.ops[1]), null) // el chofer no manda método
    assert.equal((await txDe(g.ops[0])).length, 0)
    assert.equal(await AlquileresModel.cobrarAlCerrar(g.ops[0], { [g.ops[0]]: '100', [g.ops[1]]: '200' }, 'efectivo'), 300)
    const metodos = (await prueba.q(`SELECT metodo_pago FROM op_encabezado WHERE id_grupo = ? ORDER BY id`, [g.id_grupo])).rows.map(r => r.metodo_pago)
    assert.deepEqual(metodos, ['efectivo', 'efectivo'])
    assert.deepEqual([(await txDe(g.ops[0]))[0].monto, (await txDe(g.ops[1]))[0].monto], [100, 200])
  })

  it('por alquiler: un contenedor repuesto sigue abierto', async () => {
    await datos.crearContenedores(1) // garantiza una unidad disponible para reponer
    const g = await grupoEnCurso({ cobro_modo: 'alquiler' })
    await AlquileresModel.reponerContenedor(g.ops[0])
    await retirar(g.ops[1])
    assert.equal(await AlquileresModel.cobrarAlCerrar(g.ops[1]), null)
    const grupo = await AlquileresModel.grupoDe(g.ops[0])
    assert.deepEqual(grupo.ops.map(o => o.abierta), [true, false])
  })

  it('por alquiler: un contenedor que pasa directo al próximo alquiler cuenta como retirado', async () => {
    const g = await grupoEnCurso({ cobro_modo: 'alquiler' })
    const otroCliente = await datos.crearCliente()
    await AlquileresModel.crearProgramado({
      ...datos.datosComunes({ id_cliente: otroCliente, id_administrativo: admin }),
      id_contenedor: g.conts[0], alquiler_actual_id: g.ops[0], plazo_alquiler: 4, precio_alquiler: 100,
    })
    await AlquileresModel.registrarRetiro(g.ops[0])
    await AlquileresModel.iniciarProximoAlquiler(g.ops[0])
    assert.equal(await AlquileresModel.cobrarAlCerrar(g.ops[0]), null) // falta el otro contenedor
    await retirar(g.ops[1])
    const total = (await precioCierre(g.ops[0])) + (await precioCierre(g.ops[1]))
    assert.equal(await AlquileresModel.cobrarAlCerrar(g.ops[1]), total)
    assert.deepEqual([(await txDe(g.ops[0])).length, (await txDe(g.ops[1])).length], [1, 1])
  })

  it('por alquiler: anulado un contenedor pendiente, se cobra lo retirado', async () => {
    const g = await grupoEnCurso({ cobro_modo: 'alquiler', en_curso: false })
    await AlquileresModel.entregar(g.ops[0])
    await retirar(g.ops[0])
    assert.equal(await AlquileresModel.cobrarAlCerrar(g.ops[0]), null)
    await AlquileresModel.anular(g.ops[1])
    assert.equal(await AlquileresModel.cobrarGrupo(g.id_grupo), await precioCierre(g.ops[0]))
    assert.deepEqual([(await txDe(g.ops[0])).length, (await txDe(g.ops[1])).length], [1, 0])
  })

  it('Cobranzas: un grupo "a convenir" aparece una sola vez y recién con todo retirado', async () => {
    const g = await grupoEnCurso({ cobro_modo: 'alquiler', metodo_pago: 'a_convenir' })
    await retirar(g.ops[0])
    let filas = (await AlquileresModel.pendientesDeCobro()).filter(p => p.id_grupo === g.id_grupo)
    assert.equal(filas.length, 0)
    await retirar(g.ops[1])
    filas = (await AlquileresModel.pendientesDeCobro()).filter(p => p.id_grupo === g.id_grupo)
    assert.equal(filas.length, 1)
    assert.equal(filas[0].esGrupo, true)
    assert.deepEqual(filas[0].ops.map(o => o.id).sort((a, b) => a - b), g.ops)
  })

  it('Cobranzas: resolver el grupo cobra todos sus contenedores con los montos de cada uno', async () => {
    const g = await grupoEnCurso({ cobro_modo: 'alquiler', metodo_pago: 'a_convenir' })
    await retirar(g.ops[0]); await retirar(g.ops[1])
    const user = { id: admin, rol: 'dueno' }
    const r = await llamar('resolverCobranza', { user, params: { id: String(g.ops[0]) }, body: {
      metodo_pago_final: 'efectivo', precio_final: { ['op' + g.ops[0]]: '100', ['op' + g.ops[1]]: '250' },
    } })
    assert.deepEqual(r.flashes, [{ tipo: 'success', msg: 'Cobro registrado por $350.' }])
    assert.deepEqual([(await txDe(g.ops[0]))[0].monto, (await txDe(g.ops[1]))[0].monto], [100, 250])
  })

  it('anular el último contenedor pendiente de un grupo cobra lo ya retirado', async () => {
    const g = await grupoEnCurso({ cobro_modo: 'alquiler', en_curso: false })
    await AlquileresModel.entregar(g.ops[0])
    await retirar(g.ops[0])
    await AlquileresModel.cobrarAlCerrar(g.ops[0])
    const r = await llamar('anular', { user: { id: admin, rol: 'dueno' }, params: { id: String(g.ops[1]) } })
    assert.match(r.flashes[0].msg, /^Alquiler anulado\. Se cobró el resto del alquiler agrupado por \$/)
    assert.equal((await txDe(g.ops[0])).length, 1)
  })

  it('no se puede borrar por separado una transacción de un cobro agrupado con cuenta corriente', async () => {
    const g = await grupoEnCurso({ cobro_modo: 'alquiler', metodo_pago: 'cuenta_corriente', cuentaCorriente: true })
    await retirar(g.ops[0]); await retirar(g.ops[1])
    await AlquileresModel.cobrarAlCerrar(g.ops[1])
    const tx = (await prueba.q(`SELECT id FROM transacciones WHERE id_op_encabezado = ?`, [g.ops[1]])).rows[0]
    await assert.rejects(TransaccionesModel.eliminar(tx.id), /no se puede eliminar una transacción por separado/)
    assert.equal((await txDe(g.ops[1])).length, 1)
  })

  it('cuentas corrientes: el cargo único del grupo cuenta para todas sus OP', async () => {
    const g = await grupoEnCurso({ cobro_modo: 'alquiler', metodo_pago: 'cuenta_corriente', cuentaCorriente: true })
    const sinCargo = async () => (await ClientesModel.operacionesSinCargo(g.id_cliente)).map(o => o.id).sort((a, b) => a - b)
    assert.deepEqual(await sinCargo(), g.ops) // en curso: todavía sin cargo
    await retirar(g.ops[0]); await retirar(g.ops[1])
    await AlquileresModel.cobrarAlCerrar(g.ops[1])
    assert.deepEqual(await sinCargo(), [])
  })
})
