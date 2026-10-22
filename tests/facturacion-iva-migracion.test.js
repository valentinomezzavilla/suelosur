'use strict'
// Migración única: las OP pendientes de facturar marcadas con el criterio viejo (IVA incluido)
// pasan a neto + 21%. Corre dentro de la transacción de prueba (ROLLBACK al final).
const prueba = require('./helpers/db')
const datos = require('./helpers/datos')
const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const VentasModel = require('../src/models/ventas.model')
const AlquileresModel = require('../src/models/alquileres.model')
const FacturacionModel = require('../src/models/facturacion.model')

describe('sumar IVA a las pendientes de facturar viejas', () => {
  let admin, producto

  before(async () => {
    await prueba.abrir()
    admin = await datos.idAdministrativo()
    producto = (await prueba.q(`SELECT id FROM productos WHERE COALESCE(es_contenedor,0)=0 ORDER BY id LIMIT 1`)).rows[0].id
    // La migración real no tiene que haber corrido en esta base de prueba
    await prueba.q(`CREATE TABLE IF NOT EXISTS migraciones_aplicadas (nombre TEXT PRIMARY KEY, aplicada_en TEXT)`)
    await prueba.q(`DELETE FROM migraciones_aplicadas WHERE nombre = 'iva_sobre_neto_pendientes'`)
  })
  after(() => prueba.cerrar())

  const marcarVieja = (id) => prueba.q(`UPDATE op_encabezado SET para_facturar = 1, iva_alicuota = NULL WHERE id = ?`, [id])
  const venta = async (id_cliente, metodo_pago, neto) => (await VentasModel.crear({
    id_cliente, id_administrativo: admin, tipo_op: 'M', modalidad: 'deposito', metodo_pago, monto_total: neto,
    detalles: [{ id_producto: producto, cantidad_pedida: 1, precio_unitario: neto }],
  })).id
  const cargos = async (id) => (await prueba.q(`SELECT tipo, monto FROM movimientos_cuenta WHERE id_op_encabezado = ? ORDER BY id`, [id])).rows.map(r => [r.tipo, Number(r.monto)])
  const txs = async (id) => (await prueba.q(`SELECT monto FROM transacciones WHERE id_op_encabezado = ? ORDER BY id`, [id])).rows.map(r => Number(r.monto))
  const saldo = async (id) => Number((await prueba.q(`SELECT saldo FROM clientes WHERE id = ?`, [id])).rows[0].saldo)

  it('suma el 21% a lo que deben y no toca las facturadas ni las que no son para facturar', async () => {
    // Venta vieja a cuenta corriente, pendiente de facturar
    const cliCC = await datos.crearCliente({ cuentaCorriente: true })
    const ventaCC = await venta(cliCC, 'cuenta_corriente', 1000)
    await marcarVieja(ventaCC)
    await VentasModel.sincronizarCargoCC(ventaCC)
    assert.deepEqual(await cargos(ventaCC), [['deuda', -1000]])

    // Alquiler viejo, ya retirado y cobrado a cuenta corriente
    const cliAlq = await datos.crearCliente({ cuentaCorriente: true })
    const [cont] = await datos.crearContenedores(1)
    const alq = await AlquileresModel.crearEnCurso({
      ...datos.datosComunes({ id_cliente: cliAlq, id_administrativo: admin, metodo_pago: null, fecha_inicio: '2026-10-01' }),
      id_contenedor: cont, plazo_alquiler: 4,
    })
    await AlquileresModel.devolverAPlanta(alq.id)
    await AlquileresModel.asignarPrecio(alq.id, { precio: 50000, metodo_pago: 'cuenta_corriente' })
    await marcarVieja(alq.id)

    // Ya facturada (vieja): no se toca
    const cliFact = await datos.crearCliente({ cuentaCorriente: true })
    const fact = await venta(cliFact, 'cuenta_corriente', 2000)
    await marcarVieja(fact)
    await prueba.q(`UPDATE op_encabezado SET facturado = 1, nro_factura = 'B 1' WHERE id = ?`, [fact])
    await VentasModel.sincronizarCargoCC(fact)

    // No es para facturar: no se toca
    const comun = await venta(cliFact, 'cuenta_corriente', 3000)
    await VentasModel.sincronizarCargoCC(comun)

    const nros = await FacturacionModel.sumarIvaAPendientesViejas()
    assert.ok(Array.isArray(nros) && nros.length >= 2)

    assert.deepEqual(await cargos(ventaCC), [['deuda', -1210]])
    assert.equal(await saldo(cliCC), -1210)
    assert.deepEqual(await txs(alq.id), [60500])
    assert.deepEqual(await cargos(alq.id), [['deuda', -50000], ['deuda', -10500]])
    assert.equal(await saldo(cliAlq), -60500)
    const f = await FacturacionModel.estadoOp(alq.id)
    assert.deepEqual([f.con_iva, f.neto, f.iva, f.monto], [true, 50000, 10500, 60500])

    assert.deepEqual(await cargos(fact), [['deuda', -2000]])
    assert.deepEqual(await cargos(comun), [['deuda', -3000]])
    assert.equal(await saldo(cliFact), -5000)

    const bkp = (await prueba.q(`SELECT op_id, cargo FROM bkp_iva_sobre_neto WHERE op_id = ?`, [ventaCC])).rows[0]
    assert.equal(Number(bkp.cargo), -1000)
  })

  it('corre una sola vez: la segunda no hace nada', async () => {
    assert.equal(await FacturacionModel.sumarIvaAPendientesViejas(), null)
  })
})
