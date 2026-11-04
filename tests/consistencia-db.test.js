'use strict'
// Consistencia entre módulos, contra la base (transacción de prueba: ROLLBACK al final):
// fecha de compra / envío / pago, imputación de pagos, Liquidación ↔ Cuenta corriente,
// Transacciones (entradas y salidas) y sueldos en Flota de Personal.
const prueba = require('./helpers/db')
const datos = require('./helpers/datos')
const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const VentasModel = require('../src/models/ventas.model')
const ClientesModel = require('../src/models/clientes.model')
const TransaccionesModel = require('../src/models/transacciones.model')
const LiquidacionesModel = require('../src/models/liquidaciones.model')
const MovimientosDinero = require('../src/models/movimientosDinero.model')
const PagosEmpleadoModel = require('../src/models/pagos_empleado.model')
const Tercero = require('../src/services/tercero.service')
const { normalizarFiltros } = require('../src/utils/liquidaciones')
const { hoyISO } = require('../src/utils/fecha')

function llamar(Controller, accion, { body = {}, params = {}, query = {}, user }) {
  return new Promise((resolve, reject) => {
    const flashes = []
    const req = { body, params, query, baseUrl: '', session: { user }, flash: (tipo, msg) => flashes.push({ tipo, msg }), get: () => null }
    const res = {
      redirect: (url) => resolve({ url, flashes }),
      render: (vista, data) => resolve({ vista, data, flashes }),
      json: (data) => resolve({ json: data, flashes }),
      status() { return this },
    }
    Promise.resolve(Controller[accion](req, res)).catch(reject)
  })
}

const HOY = hoyISO()
const liq = (cliente, desde, hasta, extra = {}) =>
  LiquidacionesModel.liquidacion(normalizarFiltros({ clienteId: String(cliente), desde, hasta, ...extra }, HOY))

describe('consistencia de fechas y pagos entre módulos', () => {
  let admin, user, producto

  before(async () => {
    await prueba.abrir()
    admin = await datos.idAdministrativo()
    user = { id: admin, rol: 'dueno' }
    producto = (await prueba.q(`SELECT id FROM productos WHERE COALESCE(es_contenedor,0)=0 ORDER BY id LIMIT 1`)).rows[0].id
  })
  after(() => prueba.cerrar())

  const ventaCC = async (cliente, { compra, envio, neto }) => {
    const id = (await VentasModel.crear({
      id_cliente: cliente, id_administrativo: admin, tipo_op: 'M', modalidad: 'flete', metodo_pago: 'cuenta_corriente',
      fecha_emision: compra, fecha_entrega_planificada: envio, domicilio: { calle: 'Colón', altura: '100' }, obra: null,
      precio_flete: 0, monto_total: neto, detalles: [{ id_producto: producto, cantidad_pedida: 1, precio_unitario: neto }],
    })).id
    await VentasModel.sincronizarCargoCC(id)
    return id
  }

  describe('venta con viaje: fecha de compra, de envío y de pago', () => {
    const VentasController = require('../src/controllers/ventas.controller')
    const cuerpo = (cliente, extra) => ({
      clienteId: String(cliente), clienteNombre: 'PRUEBA', calle: 'Colón', numero: '100', productoId: String(producto), cantidad: '1',
      metodoPago: 'cuenta_corriente', finalizarAhora: 'false', ...extra,
    })

    it('comprada en septiembre y enviada en octubre: es de septiembre en la cuenta y en la liquidación', async () => {
      const cliente = await datos.crearCliente({ cuentaCorriente: true })
      const r = await llamar(VentasController, 'crearViaje', { user, body: cuerpo(cliente, { fechaCompra: '2026-09-28', fecha: '2026-10-02' }) })
      assert.match(r.url, /^\/ventas\/\d+$/, JSON.stringify(r.flashes))
      const id = r.url.split('/').pop()
      const op = (await prueba.q(`SELECT fecha_emision, fecha_entrega_planificada FROM op_encabezado WHERE id = ?`, [id])).rows[0]
      assert.deepEqual([op.fecha_emision, op.fecha_entrega_planificada], ['2026-09-28', '2026-10-02'])
      const cargo = (await prueba.q(`SELECT created_at FROM movimientos_cuenta WHERE id_op_encabezado = ? AND tipo = 'deuda'`, [id])).rows[0]
      assert.equal(String(cargo.created_at).slice(0, 10), '2026-09-28')
      assert.equal((await liq(cliente, '2026-09-01', '2026-09-30')).clientes[0].operaciones.length, 1)
      assert.equal((await liq(cliente, '2026-10-01', '2026-10-31')).clientes[0].operaciones.length, 0)
    })

    it('envío anterior a la compra o compra futura: no se carga', async () => {
      const cliente = await datos.crearCliente({ cuentaCorriente: true })
      const a = await llamar(VentasController, 'crearViaje', { user, body: cuerpo(cliente, { fechaCompra: '2026-10-10', fecha: '2026-10-02' }) })
      assert.equal(a.url, '/ventas/viaje')
      assert.match(a.flashes[0].msg, /envío no puede ser anterior a la fecha de compra/)
      const b = await llamar(VentasController, 'crearViaje', { user, body: cuerpo(cliente, { fechaCompra: '2099-01-01', fecha: '2099-01-02' }) })
      assert.match(b.flashes[0].msg, /fecha de compra no puede ser posterior a hoy/)
    })

    it('finalizada ahora de contado: el cobro queda con la fecha de pago elegida', async () => {
      const cliente = await datos.crearCliente()
      const r = await llamar(VentasController, 'crearViaje', { user, body: cuerpo(cliente, {
        metodoPago: 'efectivo', finalizarAhora: 'true', fechaCompra: '2026-10-28', fecha: '2026-10-29', fechaPago: '2026-10-30' }) })
      const id = r.url.split('/').pop()
      const tx = (await prueba.q(`SELECT fecha, created_at FROM transacciones WHERE id_op_encabezado = ?`, [id])).rows[0]
      assert.equal(tx.fecha, '2026-10-30 12:00:00')
      assert.equal(String(tx.created_at).slice(0, 10), HOY)
    })

    it('corregir la fecha de compra al editar mueve el cargo de la cuenta corriente', async () => {
      const cliente = await datos.crearCliente({ cuentaCorriente: true })
      const id = await ventaCC(cliente, { compra: '2026-10-20', envio: '2026-10-25', neto: 300 })
      await VentasModel.actualizarViaje(id, { calle: 'Colón', numero: '100', fecha: '2026-10-25', fechaCompra: '2026-10-15' })
      const cargo = (await prueba.q(`SELECT created_at FROM movimientos_cuenta WHERE id_op_encabezado = ? AND tipo = 'deuda'`, [id])).rows[0]
      assert.equal(String(cargo.created_at).slice(0, 10), '2026-10-15')
    })
  })

  describe('pagos de cuenta corriente con fecha de pago', () => {
    const ClientesController = require('../src/controllers/clientes.controller')

    it('"Saldar" con un día anterior: el pago queda en ese día y el día de carga aparte', async () => {
      const cliente = await datos.crearCliente({ cuentaCorriente: true })
      await llamar(ClientesController, 'abonar', { user, params: { id: cliente }, body: { monto: '100', metodo_pago: 'efectivo', fecha: '2026-10-30' } })
      const m = (await prueba.q(`SELECT created_at, registrado_en FROM movimientos_cuenta WHERE cliente_id = ? AND tipo = 'pago'`, [cliente])).rows[0]
      assert.equal(m.created_at, '2026-10-30 12:00:00')
      assert.equal(String(m.registrado_en).slice(0, 10), HOY)
    })

    it('fecha futura: no se registra', async () => {
      const cliente = await datos.crearCliente({ cuentaCorriente: true })
      const r = await llamar(ClientesController, 'abonar', { user, params: { id: cliente }, body: { monto: '100', metodo_pago: 'efectivo', fecha: '2099-01-01' } })
      assert.match(r.flashes[0].msg, /posterior a hoy/)
      assert.equal((await prueba.q(`SELECT 1 FROM movimientos_cuenta WHERE cliente_id = ?`, [cliente])).rowCount, 0)
    })
  })

  describe('imputación única y Liquidación ↔ Cuenta corriente', () => {
    it('un pago adelantado cubre la compra siguiente también en la liquidación', async () => {
      const cliente = await datos.crearCliente({ cuentaCorriente: true })
      await ClientesModel.agregarMovimiento(cliente, { tipo: 'pago', descripcion: 'Adelanto', monto: 500, metodo_pago: 'efectivo', fecha: '2026-10-01 10:00:00' })
      const id = await ventaCC(cliente, { compra: '2026-10-05', envio: '2026-10-05', neto: 500 })
      const op = (await liq(cliente, '2026-10-01', '2026-10-31')).clientes[0].operaciones.find(o => String(o.id) === String(id))
      assert.equal(op.estado, 'pagada')
      assert.equal((await ClientesModel.pendientePorCargo(cliente))[
        (await prueba.q(`SELECT id FROM movimientos_cuenta WHERE id_op_encabezado = ?`, [id])).rows[0].id], 0)
    })

    it('la liquidación de octubre explica la deuda de septiembre y llega exacto al saldo de la cuenta', async () => {
      const cliente = await datos.crearCliente({ cuentaCorriente: true })
      await ventaCC(cliente, { compra: '2026-09-20', envio: '2026-09-20', neto: 649800 })
      await ventaCC(cliente, { compra: '2026-10-10', envio: '2026-10-10', neto: 4719000 })
      const r = await liq(cliente, '2026-10-01', '2026-10-31')
      const saldo = (await prueba.q(`SELECT saldo FROM clientes WHERE id = ?`, [cliente])).rows[0].saldo
      assert.equal(r.resumen.saldo, 4719000)
      assert.equal(r.conciliacion.deudaCuenta, -saldo)
      assert.equal(r.conciliacion.deudaCuenta, 5368800)
      assert.deepEqual(r.conciliacion.renglones.map(x => [x.clave, x.signo * x.importe]), [['anteriores', 649800]])
    })
  })

  describe('Transacciones: todo el movimiento de plata', () => {
    it('cobros, pagos de clientes y sueldos en un solo listado, con botones por tipo', async () => {
      const cliente = await datos.crearCliente({ cuentaCorriente: true })
      const nombre = `PRUEBA GRUPOS`
      await TransaccionesModel.crear({ tipo: 'Venta Cantera', cliente_id: cliente, cliente: nombre, monto: 1000, metodo_pago: 'efectivo', fecha: '2026-10-10 12:00:00' })
      await TransaccionesModel.crear({ tipo: 'Venta Viaje', cliente_id: cliente, cliente: nombre, monto: 400, metodo_pago: 'cuenta_corriente', fecha: '2026-10-11 12:00:00' })
      await ClientesModel.agregarMovimiento(cliente, { tipo: 'pago', descripcion: 'Pago', monto: 250, metodo_pago: 'transferencia', fecha: '2026-10-12 12:00:00' })
      const emp = (await datos.crearChofer()).id_empleado
      await PagosEmpleadoModel.registrar({ id_empleado: emp, tipo: 'sueldo', periodo: '2026-10', monto: 700, fecha: '2026-10-13', metodo_pago: 'efectivo' })

      const f = { fechaDesde: '2026-10-10', fechaHasta: '2026-10-13' }
      const todas = await MovimientosDinero.listar({ ...f, cliente: 'GRUPOS', limit: 50 })
      const porOrigen = (o) => todas.rows.filter(r => r.origen === o)
      assert.equal(porOrigen('transaccion').length, 2)
      assert.equal(porOrigen('pago_cliente').length, 1)

      const sueldos = await MovimientosDinero.listar({ ...f, categoria: 'sueldos', cliente: 'Chofer Prueba', limit: 50 })
      assert.equal(sueldos.rows.length, 1)
      assert.equal(sueldos.rows[0].sentido, 'salida')
      assert.ok(sueldos.rows[0].id_pago_empleado)

      const res = await MovimientosDinero.resumen({ ...f, cliente: 'GRUPOS' })
      assert.deepEqual([res.entradas, res.salidas, res.aCuenta], [1250, 0, 400])
      assert.equal(res.conteo.ventas, 2)
      assert.equal(res.conteo.pagos_clientes, 1)
      const ventaCC = porOrigen('transaccion').find(r => r.metodo_pago === 'cuenta_corriente')
      assert.equal(ventaCC.sentido, 'a_cuenta')
    })

    it('corregir la fecha de pago de un cobro (no de una venta a cuenta corriente)', async () => {
      const cliente = await datos.crearCliente({ cuentaCorriente: true })
      const contado = await TransaccionesModel.crear({ tipo: 'Venta Cantera', cliente_id: cliente, cliente: 'X', monto: 100, metodo_pago: 'efectivo' })
      await TransaccionesModel.cambiarFechaPago(contado, '2026-10-30')
      assert.equal((await TransaccionesModel.obtener(contado)).fecha, '2026-10-30 12:00:00')
      const cc = await TransaccionesModel.crear({ tipo: 'Venta Cantera', cliente_id: cliente, cliente: 'X', monto: 100, metodo_pago: 'cuenta_corriente' })
      await assert.rejects(TransaccionesModel.cambiarFechaPago(cc, '2026-10-30'), /cuenta corriente/)
    })
  })

  describe('sueldos en Flota de Personal', () => {
    it('el sueldo que pagó un cliente con transferencia aparece en la ficha, con quién lo pagó, y no se borra desde ahí', async () => {
      const cliente = await datos.crearCliente()
      const emp = (await datos.crearChofer()).id_empleado
      const tx = await TransaccionesModel.crear({ tipo: 'Venta Cantera', cliente_id: cliente, cliente: 'PRUEBA GRUPOS', monto: 900, metodo_pago: 'transferencia', fecha: '2026-10-20 12:00:00' })
      await Tercero.crearEgreso({ categoria: 'sueldo', id_empleado: String(emp), periodo: '2026-10' }, { monto: 900, fecha: '2026-10-20', id_transaccion: tx, descripcion: 'Transferencia de cliente' })

      const pagos = await PagosEmpleadoModel.listar(emp, { desde: '2026-10-01', hasta: '2026-10-31' })
      assert.equal(pagos.length, 1)
      assert.equal(pagos[0].de_tercero, true)
      assert.equal(pagos[0].pagado_por, 'PRUEBA GRUPOS')
      await assert.rejects(PagosEmpleadoModel.eliminar(pagos[0].id, emp), /lo hizo un cliente/)
      assert.deepEqual((await PagosEmpleadoModel.delMes('2026-10'))[emp], { sueldo: 900, otros: 0 })

      // Corregir la fecha de pago del cobro lleva también la del sueldo
      await TransaccionesModel.cambiarFechaPago(tx, '2026-10-18')
      assert.equal((await PagosEmpleadoModel.listar(emp, {}))[0].fecha, '2026-10-18')
    })

    it('Flota de Personal: listado con el sueldo del mes y ficha con sus pagos', async () => {
      const EmpleadosController = require('../src/controllers/empleados.controller')
      const emp = (await datos.crearChofer()).id_empleado
      await prueba.q(`UPDATE empleados SET sueldo_basico = 1000 WHERE id = ?`, [emp])
      await PagosEmpleadoModel.registrar({ id_empleado: emp, tipo: 'anticipo', periodo: '2026-10', monto: 400, fecha: '2026-10-05' })
      const idx = await llamar(EmpleadosController, 'index', { user, query: { q: 'Chofer', mes: '2026-10' } })
      const e = idx.data.empleados.find(x => String(x.id) === String(emp))
      assert.deepEqual(e.sueldoMes, { establecido: 1000, pagado: 400, otros: 0, estado: 'parcial' })
      const det = await llamar(EmpleadosController, 'detalle', { user, params: { id: emp }, query: { mes: '2026-10' } })
      assert.equal(det.vista, 'pages/empleados/detalle')
      assert.equal(det.data.pagos.length, 1)
      const r = await llamar(EmpleadosController, 'registrarPago', { user, params: { id: emp }, body: { tipo: 'sueldo', monto: '600', periodo: '2026-10', fecha: '2026-10-31' } })
      assert.equal(r.flashes[0].tipo, 'success')
      assert.deepEqual((await PagosEmpleadoModel.delMes('2026-10'))[emp], { sueldo: 1000, otros: 0 })
    })
  })
})
