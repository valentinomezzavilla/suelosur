'use strict'
// La fecha de un cargo en la cuenta corriente es la de su operación (la misma que usa la
// Liquidación), no la del día en que se cobró o se corrigió. Una operación de septiembre
// cobrada en octubre sigue siendo de septiembre: no tiene que aparecer al filtrar octubre.
// Corre dentro de la transacción de prueba (ROLLBACK al final: nada queda guardado).
const prueba = require('./helpers/db')
const datos = require('./helpers/datos')
const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const AlquileresModel = require('../src/models/alquileres.model')
const AlquileresMaquinariaModel = require('../src/models/alquileres_maquinaria.model')
const ClientesModel = require('../src/models/clientes.model')
const FacturacionModel = require('../src/models/facturacion.model')
const TransaccionesModel = require('../src/models/transacciones.model')
const { hoyISO } = require('../src/utils/fecha')

const correrDias = (iso, n) => {
  const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + n)
  const p = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
const haceDias = (n) => correrDias(hoyISO(), -n)

describe('fecha de los cargos de cuenta corriente = fecha de la operación', () => {
  let admin

  before(async () => {
    await prueba.abrir()
    admin = await datos.idAdministrativo()
  })
  after(prueba.cerrar)

  const comunes = (id_cliente, dias) => datos.datosComunes({
    id_cliente, id_administrativo: admin, metodo_pago: null, fecha_inicio: haceDias(dias),
  })
  async function alquilerEnCurso({ dias, metodo = 'cuenta_corriente' }) {
    const id_cliente = await datos.crearCliente({ cuentaCorriente: true, saldo: 0 })
    const [cont] = await datos.crearContenedores(1)
    const r = await AlquileresModel.crearEnCurso({ ...comunes(id_cliente, dias), id_contenedor: cont, plazo_alquiler: 4 })
    await AlquileresModel.asignarPrecio(r.id, { precio: '1000', metodo_pago: metodo })
    return { id: r.id, id_cliente, inicio: haceDias(dias) }
  }
  const movs = async (id_cliente) => (await prueba.q(
    `SELECT id, tipo, monto, created_at, id_op_encabezado FROM movimientos_cuenta WHERE cliente_id = ? ORDER BY id`, [id_cliente])).rows
  const dia = (m) => String(m.created_at).slice(0, 10)

  it('cobrar al retirar un alquiler que empezó hace 20 días: el cargo queda en el día de inicio', async () => {
    const a = await alquilerEnCurso({ dias: 20 })
    await AlquileresModel.devolverAPlanta(a.id)
    await AlquileresModel.cobrarAlCerrar(a.id)
    const m = await movs(a.id_cliente)
    assert.equal(m.length, 1)
    assert.equal(dia(m[0]), a.inicio)
  })

  it('asignar el precio de un alquiler ya retirado: el cargo queda en el día de inicio', async () => {
    const id_cliente = await datos.crearCliente({ cuentaCorriente: true })
    const [cont] = await datos.crearContenedores(1)
    const r = await AlquileresModel.crearEnCurso({ ...comunes(id_cliente, 15), id_contenedor: cont, plazo_alquiler: 4 })
    await AlquileresModel.devolverAPlanta(r.id)
    await AlquileresModel.asignarPrecio(r.id, { precio: '2500', metodo_pago: 'cuenta_corriente' })
    const m = await movs(id_cliente)
    assert.equal(m.length, 1)
    assert.equal(dia(m[0]), haceDias(15))
  })

  it('alquiler de varios contenedores cobrado todo junto: un solo cargo, en el día de inicio', async () => {
    const id_cliente = await datos.crearCliente({ cuentaCorriente: true })
    const conts = await datos.crearContenedores(2)
    const g = await AlquileresModel.crearGrupo({
      ...comunes(id_cliente, 12), en_curso: true,
      contenedores: conts.map(id_contenedor => ({ id_contenedor, plazo_alquiler: 4 })),
    })
    const ids = g.ops.map(o => o.id)
    for (const id of ids) await AlquileresModel.devolverAPlanta(id)
    await AlquileresModel.asignarPrecioGrupo(ids[0], {
      precios: { [ids[0]]: '100', [ids[1]]: '250' }, metodo_pago: 'cuenta_corriente',
    })
    const m = await movs(id_cliente)
    assert.equal(m.length, 1)
    assert.equal(m[0].monto, -350)
    assert.equal(dia(m[0]), haceDias(12))
  })

  it('alquiler de maquinaria pasado: el cargo (mismo agregarMovimiento que usa el alta) va en la fecha planificada', async () => {
    const id_cliente = await datos.crearCliente({ cuentaCorriente: true })
    const r = await AlquileresMaquinariaModel.crear({
      id_cliente, id_administrativo: admin, domicilio_entrega: 'San Lorenzo 501', precio_total: 5000,
      metodo_pago: 'cuenta_corriente', fecha_entrega_planificada: haceDias(9),
    })
    await ClientesModel.agregarMovimiento(id_cliente, {
      tipo: 'deuda', descripcion: 'Alquiler maquinaria', monto: -5000, id_op_encabezado: r.id,
    })
    const m = await movs(id_cliente)
    assert.equal(dia(m[0]), haceDias(9))
  })

  it('pasar a cuenta corriente la transacción de una operación vieja: el cargo va en la fecha de la operación', async () => {
    const a = await alquilerEnCurso({ dias: 18, metodo: 'efectivo' })
    await AlquileresModel.devolverAPlanta(a.id)
    await AlquileresModel.cobrarAlCerrar(a.id)
    assert.deepEqual(await movs(a.id_cliente), [])
    const tx = (await prueba.q(`SELECT id FROM transacciones WHERE id_op_encabezado = ?`, [a.id])).rows[0]
    await TransaccionesModel.cambiarMetodoPago(tx.id, 'cuenta_corriente')
    const m = await movs(a.id_cliente)
    assert.equal(m.length, 1)
    assert.equal(dia(m[0]), a.inicio)
  })

  it('marcar "para facturar" una operación vieja: el IVA se suma en el día de la operación', async () => {
    const a = await alquilerEnCurso({ dias: 25 })
    await AlquileresModel.devolverAPlanta(a.id)
    await AlquileresModel.cobrarAlCerrar(a.id)
    await FacturacionModel.marcar(a.id)
    const m = await movs(a.id_cliente)
    assert.equal(m.length, 2)
    assert.deepEqual(m.map(dia), [a.inicio, a.inicio])
  })

  it('una operación que empieza hoy conserva la hora real del cargo (no se fuerza a las 12:00)', async () => {
    const a = await alquilerEnCurso({ dias: 0 })
    await AlquileresModel.devolverAPlanta(a.id)
    await AlquileresModel.cobrarAlCerrar(a.id)
    const m = await movs(a.id_cliente)
    assert.equal(dia(m[0]), hoyISO())
    assert.notEqual(String(m[0].created_at).slice(11), '12:00:00')
  })

  it('un pago o un cargo manual (sin operación) sigue fechándose en el momento en que se registra', async () => {
    const id_cliente = await datos.crearCliente({ cuentaCorriente: true })
    await ClientesModel.agregarMovimiento(id_cliente, { tipo: 'pago', descripcion: 'Pago', monto: 500, metodo_pago: 'efectivo' })
    await ClientesModel.agregarMovimiento(id_cliente, { tipo: 'deuda', descripcion: 'Cargo manual', monto: -300 })
    assert.deepEqual((await movs(id_cliente)).map(dia), [hoyISO(), hoyISO()])
  })

  it('el estado de cuenta de un período posterior no trae el cargo, y su saldo inicial sí lo arrastra', async () => {
    const a = await alquilerEnCurso({ dias: 20 })
    await AlquileresModel.devolverAPlanta(a.id)
    await AlquileresModel.cobrarAlCerrar(a.id)

    const mesDelAlquiler = await ClientesModel.estadoCuenta(a.id_cliente, { desde: a.inicio, hasta: a.inicio })
    assert.equal(mesDelAlquiler.movimientos.length, 1)

    const periodoPosterior = await ClientesModel.estadoCuenta(a.id_cliente, { desde: correrDias(a.inicio, 1), hasta: hoyISO() })
    assert.equal(periodoPosterior.movimientos.length, 0)
    assert.equal(Number(periodoPosterior.saldoInicial), -1000)
  })
})
