'use strict'
// Casos encontrados en la revisión de la rama (antes del Release A).
const prueba = require('./helpers/db')
const datos = require('./helpers/datos')
const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const AlquileresModel = require('../src/models/alquileres.model')
const TransaccionesModel = require('../src/models/transacciones.model')
const ConfigContenedoresModel = require('../src/models/config_contenedores.model')
const { hoyISO } = require('../src/utils/fecha')

// 'YYYY-MM-DD' corrido n días (hora local)
const correrDias = (iso, n) => {
  const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + n)
  const p = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

describe('alquileres agrupados: casos de la revisión', () => {
  let admin

  before(async () => {
    await prueba.abrir()
    admin = await datos.idAdministrativo()
  })
  after(prueba.cerrar)

  async function grupo({ cobro_modo = 'alquiler', metodo_pago = 'efectivo', cuentaCorriente = false, en_curso = true, fecha_inicio = '2026-09-28' } = {}) {
    const id_cliente = await datos.crearCliente({ cuentaCorriente })
    const conts = await datos.crearContenedores(2)
    const g = await AlquileresModel.crearGrupo({
      ...datos.datosComunes({ id_cliente, id_administrativo: admin, metodo_pago, fecha_inicio }),
      cobro_modo, en_curso,
      contenedores: conts.map(id_contenedor => ({ id_contenedor, plazo_alquiler: 4, precio_alquiler: 100 })),
    })
    return { id_cliente, conts, id_grupo: g.id_grupo, ops: g.ops.map(o => o.id) }
  }
  const retirar = (id) => AlquileresModel.devolverAPlanta(id)
  const txDe = async (id) => (await prueba.q(`SELECT id, monto FROM transacciones WHERE id_op_encabezado = ? ORDER BY id`, [id])).rows

  it('por alquiler: cada contenedor se cobra con sus propios días, no hasta el último retiro', async () => {
    const { precioDia } = await ConfigContenedoresModel.obtenerPrecios()
    const inicio = correrDias(hoyISO(), -6)
    const g = await grupo({ fecha_inicio: inicio })
    await retirar(g.ops[0])
    // El primero se entregó el día del inicio y se retiró 2 días después; el segundo se
    // retira hoy (6 días). Las fechas quedan en orden cronológico, como en la realidad.
    await prueba.q(`UPDATE movimiento_contenedor SET fecha_movimiento = ? WHERE id_contenedor = ?`, [inicio + ' 08:00:00', g.conts[0]])
    await prueba.q(`
      UPDATE movimiento_contenedor SET fecha_movimiento = ?
      WHERE estado_paso = 'disponible'
        AND id_op_contenedor = (SELECT id FROM op_detalle_contenedor WHERE id_orden_pedido = ?)`,
    [correrDias(inicio, 2) + ' 10:00:00', g.ops[0]])
    await retirar(g.ops[1])
    await AlquileresModel.cobrarAlCerrar(g.ops[1])
    assert.deepEqual([(await txDe(g.ops[0]))[0].monto, (await txDe(g.ops[1]))[0].monto], [2 * precioDia, 6 * precioDia])
  })

  it('no se puede cambiar por separado el método de pago de un cobro agrupado por alquiler', async () => {
    const cc = await grupo({ metodo_pago: 'cuenta_corriente', cuentaCorriente: true })
    await retirar(cc.ops[0]); await retirar(cc.ops[1])
    await AlquileresModel.cobrarAlCerrar(cc.ops[1])
    const [txCC] = await txDe(cc.ops[0])
    await assert.rejects(TransaccionesModel.cambiarMetodoPago(txCC.id, 'efectivo'), /no se puede cambiar por separado/)

    const ef = await grupo({ metodo_pago: 'efectivo' })
    await retirar(ef.ops[0]); await retirar(ef.ops[1])
    await AlquileresModel.cobrarAlCerrar(ef.ops[1])
    const [txEf] = await txDe(ef.ops[1])
    await assert.rejects(TransaccionesModel.cambiarMetodoPago(txEf.id, 'cuenta_corriente'), /no se puede cambiar por separado/)
  })

  it('un movimiento manual (sin OP) no da por retirado un contenedor del grupo', async () => {
    const g = await grupo()
    await prueba.q(`INSERT INTO movimiento_contenedor (id_contenedor, estado_paso, observaciones) VALUES (?, 'pendiente_retiro', 'Movimiento manual')`, [g.conts[0]])
    await retirar(g.ops[1])
    assert.equal(await AlquileresModel.cobrarAlCerrar(g.ops[1]), null)
    assert.deepEqual((await AlquileresModel.grupoDe(g.ops[0])).ops.map(o => o.abierta), [true, false])
  })

  it('una OP pendiente de entrega sigue abierta aunque su contenedor tenga un movimiento manual', async () => {
    const g = await grupo({ en_curso: false })
    await prueba.q(`INSERT INTO movimiento_contenedor (id_contenedor, estado_paso, observaciones) VALUES (?, 'disponible', 'Movimiento manual')`, [g.conts[0]])
    assert.deepEqual((await AlquileresModel.grupoDe(g.ops[0])).ops.map(o => o.abierta), [true, true])
  })

  it('Cobranzas: la fila del grupo incluye el contenedor que pasó directo al próximo alquiler', async () => {
    const g = await grupo({ metodo_pago: 'a_convenir' })
    const otroCliente = await datos.crearCliente()
    await AlquileresModel.crearProgramado({
      ...datos.datosComunes({ id_cliente: otroCliente, id_administrativo: admin }),
      id_contenedor: g.conts[0], alquiler_actual_id: g.ops[0], plazo_alquiler: 4, precio_alquiler: 100,
    })
    await AlquileresModel.registrarRetiro(g.ops[0])
    await AlquileresModel.iniciarProximoAlquiler(g.ops[0])
    await retirar(g.ops[1])
    const filas = (await AlquileresModel.pendientesDeCobro()).filter(p => p.id_grupo === g.id_grupo)
    assert.equal(filas.length, 1)
    assert.deepEqual(filas[0].ops.map(o => o.id).sort((a, b) => a - b), g.ops)
  })
})
