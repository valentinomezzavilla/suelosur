'use strict'
// Script que corrige la fecha de los cargos ya cargados en el día del cobro en vez del día
// de su operación. Corre dentro de la transacción de prueba (ROLLBACK al final).
const prueba = require('./helpers/db')
const datos = require('./helpers/datos')
const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const AlquileresModel = require('../src/models/alquileres.model')
const { candidatos, aplicar, revertir } = require('../scripts/corregir-fecha-cargos')
const { hoyISO } = require('../src/utils/fecha')

const correrDias = (iso, n) => {
  const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + n)
  const p = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
const haceDias = (n) => correrDias(hoyISO(), -n)

describe('corrección de la fecha de cargos ya cargados', () => {
  let admin

  before(async () => {
    await prueba.abrir()
    admin = await datos.idAdministrativo()
  })
  after(prueba.cerrar)

  // Alquiler de hace `dias` días cobrado a cuenta corriente, con el cargo fechado "hoy"
  // como lo dejaba el sistema antes del arreglo.
  async function alquilerConCargoMalFechado(dias) {
    const id_cliente = await datos.crearCliente({ cuentaCorriente: true })
    const [cont] = await datos.crearContenedores(1)
    const r = await AlquileresModel.crearEnCurso({
      ...datos.datosComunes({ id_cliente, id_administrativo: admin, metodo_pago: null, fecha_inicio: haceDias(dias) }),
      id_contenedor: cont, plazo_alquiler: 4,
    })
    await AlquileresModel.asignarPrecio(r.id, { precio: '1000', metodo_pago: 'cuenta_corriente' })
    await AlquileresModel.devolverAPlanta(r.id)
    await AlquileresModel.cobrarAlCerrar(r.id)
    await prueba.q(`UPDATE movimientos_cuenta SET created_at = ahora_local() WHERE id_op_encabezado = ?`, [r.id])
    return { id: r.id, id_cliente }
  }
  const fechaDelCargo = async (id_op) => (await prueba.q(
    `SELECT created_at FROM movimientos_cuenta WHERE id_op_encabezado = ?`, [id_op])).rows[0].created_at

  it('lista los cargos que cayeron después de su operación y los pasa al día de la operación', async () => {
    const a = await alquilerConCargoMalFechado(20)
    const filas = (await candidatos({ clienteId: a.id_cliente }))
    assert.equal(filas.length, 1)
    assert.equal(filas[0].fecha_op, haceDias(20))
    assert.equal(await aplicar(filas), 1)
    assert.equal(await fechaDelCargo(a.id), `${haceDias(20)} 12:00:00`)
    assert.deepEqual(await candidatos({ clienteId: a.id_cliente }), []) // ya corregido: no vuelve a salir
  })

  it('no toca el saldo del cliente ni el importe del cargo', async () => {
    const a = await alquilerConCargoMalFechado(10)
    const antes = (await prueba.q(`SELECT saldo FROM clientes WHERE id = ?`, [a.id_cliente])).rows[0].saldo
    await aplicar(await candidatos({ clienteId: a.id_cliente }))
    const despues = (await prueba.q(`SELECT saldo FROM clientes WHERE id = ?`, [a.id_cliente])).rows[0].saldo
    assert.equal(despues, antes)
    assert.equal((await prueba.q(`SELECT monto FROM movimientos_cuenta WHERE id_op_encabezado = ?`, [a.id])).rows[0].monto, -1000)
  })

  it('un cargo de una operación de hoy, o ya bien fechado, no es candidato', async () => {
    const hoy = await alquilerConCargoMalFechado(0)
    assert.deepEqual(await candidatos({ clienteId: hoy.id_cliente }), [])
    const ok = await alquilerConCargoMalFechado(7)
    await aplicar(await candidatos({ clienteId: ok.id_cliente }))
    assert.deepEqual(await candidatos({ clienteId: ok.id_cliente }), [])
  })

  it('nunca mueve un cargo hacia el futuro: si el cargo es anterior a la operación, queda como está', async () => {
    const a = await alquilerConCargoMalFechado(5)
    await prueba.q(`UPDATE movimientos_cuenta SET created_at = ? WHERE id_op_encabezado = ?`, [`${haceDias(12)} 09:00:00`, a.id])
    assert.deepEqual(await candidatos({ clienteId: a.id_cliente }), [])
  })

  it('no toca los pagos', async () => {
    const a = await alquilerConCargoMalFechado(14)
    await prueba.q(`INSERT INTO movimientos_cuenta (cliente_id, tipo, descripcion, monto) VALUES (?, 'pago', 'Pago', 400)`, [a.id_cliente])
    const filas = await candidatos({ clienteId: a.id_cliente })
    assert.deepEqual(filas.map(f => f.tipo), ['deuda'])
    await aplicar(filas)
    const pago = (await prueba.q(`SELECT created_at FROM movimientos_cuenta WHERE cliente_id = ? AND tipo = 'pago'`, [a.id_cliente])).rows[0]
    assert.equal(String(pago.created_at).slice(0, 10), hoyISO())
  })

  it('revertir devuelve las fechas anteriores desde el respaldo', async () => {
    const a = await alquilerConCargoMalFechado(16)
    const original = await fechaDelCargo(a.id)
    await aplicar(await candidatos({ clienteId: a.id_cliente }))
    assert.notEqual(await fechaDelCargo(a.id), original)
    await revertir()
    assert.equal(await fechaDelCargo(a.id), original)
  })
})
