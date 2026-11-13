'use strict'
// Vista previa de "Marcar pendiente": además del detalle, trae un resumen corto (cuánto se le
// quita a la operación, qué pagos cambian y cuántos solo se anotan) para la ventana.
// Corre dentro de la transacción de prueba (ROLLBACK al final).
const prueba = require('./helpers/db')
const datos = require('./helpers/datos')
const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const EstadoPago = require('../src/models/estadoPago.model')
const ClientesModel = require('../src/models/clientes.model')
const VentasModel = require('../src/models/ventas.model')
const TransaccionesModel = require('../src/models/transacciones.model')

describe('Marcar pendiente: resumen de la vista previa', () => {
  let admin, producto
  before(async () => {
    await prueba.abrir()
    admin = await datos.idAdministrativo()
    producto = (await prueba.q(`SELECT id FROM productos WHERE COALESCE(es_contenedor,0)=0 ORDER BY id LIMIT 1`)).rows[0].id
  })
  after(() => prueba.cerrar())

  const venta = async (cliente, fecha, neto, metodo = 'cuenta_corriente') => {
    const id = (await VentasModel.crear({
      id_cliente: cliente, id_administrativo: admin, tipo_op: 'M', modalidad: 'deposito', metodo_pago: metodo,
      fecha_emision: fecha, monto_total: neto, detalles: [{ id_producto: producto, cantidad_pedida: 1, precio_unitario: neto }],
    })).id
    if (metodo === 'cuenta_corriente') await VentasModel.sincronizarCargoCC(id)
    return id
  }
  // Pago "a lo más viejo" (sin elegir operaciones), como los cheques de un cliente que paga todo junto
  const pagar = async (cliente, monto, fecha = '2026-11-11 12:00:00', metodo = 'echeq') => {
    const id = await ClientesModel.agregarMovimiento(cliente, { tipo: 'pago', descripcion: 'Pago', monto, metodo_pago: metodo, fecha })
    await ClientesModel.guardarImputaciones(id, [])
    return id
  }

  it('un remito cubierto por varios pagos: dice cuánto se quita y separa los pagos que cambian de los que no', async () => {
    // Remito X de $375.100 (2 contenedores a $155.000 + IVA): lo cubren dos pagos y hay pagos
    // posteriores que no lo tocan. Los mismos importes del caso real.
    const cli = await datos.crearCliente({ cuentaCorriente: true })
    await venta(cli, '2026-10-10', 27750)                       // más vieja: la cubre el 1.er pago
    const X = await venta(cli, '2026-10-14', 375100)
    await venta(cli, '2026-10-15', 100000); await venta(cli, '2026-10-16', 200000)
    for (const m of [187550, 229900, 85400, 200000]) await pagar(cli, m)

    const p = await EstadoPago.vistaPreviaPendiente(X)
    assert.equal(p.puede, true)
    assert.equal(p.resumen.quitado, 375100)
    assert.equal(p.resumen.pagosQueCambian.length, 2)
    assert.match(p.resumen.pagosQueCambian[0], /\$187\.550,00 \(echeq\), \$159\.800,00 eran de esta operación: .*por los \$27\.750,00 que corresponden a las demás/)
    assert.match(p.resumen.pagosQueCambian[1], /\$229\.900,00 \(echeq\), \$215\.300,00 eran de esta operación: .*por los \$14\.600,00 que corresponden a las demás/)
    assert.equal(p.resumen.pagosSinCambio, 2)
    // La suma de lo que se le saca a cada pago es exactamente lo que se quita
    assert.equal(159800 + 215300, p.resumen.quitado)
    // Y el saldo se mueve lo mismo
    assert.equal(p.saldoAntes - p.saldoDespues, 375100)
  })

  it('si no se puede (bloqueos), no hay resumen que mostrar', async () => {
    const cli = await datos.crearCliente({ cuentaCorriente: true })
    const X = await venta(cli, '2026-10-10', 1000)            // en cuenta corriente y sin pagos
    const p = await EstadoPago.vistaPreviaPendiente(X)
    assert.equal(p.puede, false)
    assert.equal(p.resumen, undefined)
  })

  it('el detalle completo sigue estando (una línea por pago + el saldo)', async () => {
    const cli = await datos.crearCliente({ cuentaCorriente: true })
    const a = await venta(cli, '2026-10-10', 1000), b = await venta(cli, '2026-10-11', 1000)
    await pagar(cli, 1500)
    const p = await EstadoPago.vistaPreviaPendiente(a)
    assert.ok(p.lineas.length >= 2)
    assert.match(p.lineas[p.lineas.length - 1], /El cliente pasa a deber \$1\.000,00 más en su cuenta corriente/)
    assert.equal(p.resumen.quitado, 1000)
    assert.ok(b)
  })

  it('un pago que era todo de la operación se anula entero (no hay "resto")', async () => {
    const cli = await datos.crearCliente({ cuentaCorriente: true })
    const X = await venta(cli, '2026-10-10', 500000)
    await pagar(cli, 500000)
    const p = await EstadoPago.vistaPreviaPendiente(X)
    assert.equal(p.resumen.quitado, 500000)
    assert.equal(p.resumen.pagosQueCambian.length, 1)
    assert.match(p.resumen.pagosQueCambian[0], /^Se anula el pago del 11\/11\/2026 por \$500\.000,00 \(echeq\): era todo de esta operación\.$/)
    assert.equal(p.resumen.pagosSinCambio, 0)
  })

  it('una venta cobrada de contado: lo que se quita es el cobro, que pasa a cuenta corriente', async () => {
    const cli = await datos.crearCliente({ cuentaCorriente: true })
    const X = await venta(cli, '2026-10-10', 80000, 'efectivo')
    await TransaccionesModel.crear({ tipo: 'Venta Cantera', id_op_encabezado: X, cliente_id: cli, cliente: 'PRUEBA', monto: 80000, metodo_pago: 'efectivo', fecha: '2026-10-10' })
    const p = await EstadoPago.vistaPreviaPendiente(X)
    assert.equal(p.puede, true)
    assert.equal(p.resumen.quitado, 80000)
    assert.equal(p.resumen.pagosQueCambian.length, 1)
    assert.match(p.resumen.pagosQueCambian[0], /pasa a cuenta corriente/)
    assert.equal(p.resumen.pagosSinCambio, 0)
  })

  it('la ventana (public/js/estadoPago.js) muestra el resumen y cae al detalle si no hay', () => {
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'estadoPago.js'), 'utf8')
    assert.match(js, /Se le quitan/)
    assert.match(js, /x\.pagosSinCambio/)
    assert.match(js, /conResumen \? \(x\.pagosQueCambian \|\| \[\]\) : \(r\.lineas \|\| \[\]\)/)
    const partial = fs.readFileSync(path.join(__dirname, '..', 'views', 'partials', 'modal_estado_pago.ejs'), 'utf8')
    assert.match(partial, /id="estadoPagoResumen"/)
    assert.match(partial, /id="estadoPagoNota"/)
  })
})
