'use strict'
// Saldos unificados: Cuenta corriente, Liquidaciones y Transacciones dicen lo mismo de cada
// cliente y de cada operación. Cada prueba reproduce una diferencia que había entre módulos.
// Corre dentro de la transacción de prueba (ROLLBACK al final: nada queda guardado).
const prueba = require('./helpers/db')
const datos = require('./helpers/datos')
const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const AlquileresModel = require('../src/models/alquileres.model')
const AlquileresMaquinariaModel = require('../src/models/alquileres_maquinaria.model')
const ClientesModel = require('../src/models/clientes.model')
const ConfigContenedoresModel = require('../src/models/config_contenedores.model')
const FacturacionModel = require('../src/models/facturacion.model')
const LiquidacionesModel = require('../src/models/liquidaciones.model')
const TransaccionesModel = require('../src/models/transacciones.model')
const VentasModel = require('../src/models/ventas.model')
const { normalizarFiltros } = require('../src/utils/liquidaciones')
const { hoyISO } = require('../src/utils/fecha')

const HOY = hoyISO()
const correrDias = (iso, n) => {
  const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + n)
  const p = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
const haceDias = (n) => correrDias(HOY, -n)

function llamar(Controller, accion, { body = {}, params = {}, query = {}, user }) {
  return new Promise((resolve, reject) => {
    const flashes = []
    const req = { body, params, query, baseUrl: '', session: { user }, flash: (tipo, msg) => flashes.push({ tipo, msg }), get: () => null }
    const res = { redirect: (url) => resolve({ url, flashes }), render: (vista, data) => resolve({ vista, data, flashes }), status() { return this } }
    Promise.resolve(Controller[accion](req, res)).catch(reject)
  })
}

describe('saldos unificados entre módulos', () => {
  let admin, user, producto, cfg

  before(async () => {
    await prueba.abrir()
    admin = await datos.idAdministrativo()
    user = { id: admin, rol: 'dueno' }
    producto = (await prueba.q(`SELECT id FROM productos WHERE COALESCE(es_contenedor,0)=0 ORDER BY id LIMIT 1`)).rows[0].id
    cfg = await ConfigContenedoresModel.obtenerPrecios()
  })
  after(() => prueba.cerrar())

  const saldo = async (id) => Number((await prueba.q(`SELECT saldo FROM clientes WHERE id = ?`, [id])).rows[0].saldo)
  // Liquidación de todo el historial del cliente
  const liq = (cliente) => LiquidacionesModel.liquidacion(normalizarFiltros({ clienteId: String(cliente), desde: '2000-01-01', hasta: '2099-12-31' }, HOY))
  const opDe = async (cliente, id) => (await liq(cliente)).clientes[0].operaciones.find(o => String(o.id) === String(id))
  const cargosDe = async (id) => (await prueba.q(`SELECT tipo, monto FROM movimientos_cuenta WHERE id_op_encabezado = ? ORDER BY id`, [id])).rows
  // Lo que se debe de una operación según la Cuenta corriente (suma de lo que falta de sus cargos)
  const restaEnCuenta = async (cliente, idOp) => {
    const pend = await ClientesModel.pendientePorCargo(cliente)
    const ids = (await prueba.q(`SELECT id FROM movimientos_cuenta WHERE id_op_encabezado = ?`, [idOp])).rows.map(r => r.id)
    return Math.round(ids.reduce((s, id) => s + (pend[id] || 0), 0) * 100) / 100
  }

  const ventaCC = async (cliente, { compra = '2026-09-20', neto = 1000, metodo = 'cuenta_corriente' } = {}) => {
    const id = (await VentasModel.crear({
      id_cliente: cliente, id_administrativo: admin, tipo_op: 'M', modalidad: 'flete', metodo_pago: metodo,
      fecha_emision: compra, fecha_entrega_planificada: compra, domicilio: { calle: 'Colón', altura: '100' },
      precio_flete: 0, monto_total: neto, detalles: [{ id_producto: producto, cantidad_pedida: 1, precio_unitario: neto }],
    })).id
    await VentasModel.sincronizarCargoCC(id)
    return id
  }
  // Alquiler de contenedor con precio de alta (los de siempre): se cobra a la tarifa por los días reales
  const alquilerEnCurso = async (cliente, { metodo = 'cuenta_corriente', dias = 3, precio = 250000 } = {}) => {
    const [cont] = await datos.crearContenedores(1)
    const r = await AlquileresModel.crearEnCurso({
      ...datos.datosComunes({ id_cliente: cliente, id_administrativo: admin, metodo_pago: metodo, fecha_inicio: haceDias(dias) }),
      id_contenedor: cont, plazo_alquiler: 4, precio_alquiler: precio,
    })
    return r.id
  }
  const alquilerCobrado = async (cliente, opts = {}) => {
    const id = await alquilerEnCurso(cliente, opts)
    await AlquileresModel.devolverAPlanta(id)
    await AlquileresModel.cobrarAlCerrar(id, opts.montoAlCerrar)
    return id
  }

  describe('el saldo guardado es siempre la suma de los movimientos', () => {
    it('alta, cambio de importe, anulación, baja y cambio de cliente', async () => {
      const a = await datos.crearCliente({ cuentaCorriente: true })
      const b = await datos.crearCliente({ cuentaCorriente: true })
      const pago = await ClientesModel.agregarMovimiento(a, { tipo: 'pago', descripcion: 'Pago', monto: 1000, metodo_pago: 'efectivo' })
      const cargo = await ClientesModel.agregarMovimiento(a, { tipo: 'deuda', descripcion: 'Cargo', monto: -300 })
      assert.equal(await saldo(a), 700)
      await prueba.q(`UPDATE movimientos_cuenta SET monto = -450 WHERE id = ?`, [cargo])
      assert.equal(await saldo(a), 550)
      await ClientesModel.anularPago(pago, a, { usuario: admin, motivo: 'prueba' })
      assert.equal(await saldo(a), -450)
      await prueba.q(`UPDATE movimientos_cuenta SET cliente_id = ? WHERE id = ?`, [b, cargo])
      assert.equal(await saldo(a), 0)
      assert.equal(await saldo(b), -450)
      await ClientesModel.eliminarMovimiento(cargo)
      assert.equal(await saldo(b), 0)
    })

    it('importes grandes con centavos: sin redondeos de REAL', async () => {
      const a = await datos.crearCliente({ cuentaCorriente: true })
      await ClientesModel.agregarMovimiento(a, { tipo: 'deuda', descripcion: 'Cargo', monto: -12345678.91 })
      await ClientesModel.agregarMovimiento(a, { tipo: 'pago', descripcion: 'Pago', monto: 0.01, metodo_pago: 'efectivo' })
      assert.equal(await saldo(a), -12345678.9)
    })
  })

  describe('alquiler de contenedor: el importe es el cobrado, no el precio de alta', () => {
    it('cobrado a la tarifa por los días reales: la Liquidación muestra lo mismo que la cuenta', async () => {
      const cli = await datos.crearCliente({ cuentaCorriente: true })
      const id = await alquilerCobrado(cli, { dias: 3, precio: 250000 })
      const cobrado = 3 * cfg.precioDia
      assert.deepEqual(await cargosDe(id), [{ tipo: 'deuda', monto: -cobrado }])
      let op = await opDe(cli, id)
      assert.equal(op.total, cobrado) // antes: 250000 (el de alta)
      assert.equal(op.resta, cobrado)

      await ClientesModel.agregarMovimiento(cli, { tipo: 'pago', descripcion: 'Pago', monto: 40000, metodo_pago: 'efectivo' })
      op = await opDe(cli, id)
      assert.equal(op.pagado, 40000)
      assert.equal(op.resta, cobrado - 40000)
      assert.equal(op.resta, await restaEnCuenta(cli, id))
      const s = (await liq(cli)).saldo
      assert.equal(s.cuenta.saldo, await saldo(cli))
      assert.equal(s.cuenta.deuda, cobrado - 40000)
    })

    it('con un monto ajustado al cerrar: también', async () => {
      const cli = await datos.crearCliente({ cuentaCorriente: true })
      const id = await alquilerCobrado(cli, { dias: 3, montoAlCerrar: '123456' })
      const op = await opDe(cli, id)
      assert.equal(op.total, 123456)
      assert.equal(op.resta, await restaEnCuenta(cli, id))
    })

    it('en curso: se estima a hoy igual que en la cuenta y figura "en curso", no como deuda', async () => {
      const cli = await datos.crearCliente({ cuentaCorriente: true })
      const id = await alquilerEnCurso(cli, { dias: 3 })
      const op = await opDe(cli, id)
      assert.equal(op.estimado, true)
      assert.equal(op.total, 3 * cfg.precioDia)
      const s = await LiquidacionesModel.saldoCliente(cli)
      assert.equal(s.cuenta.saldo, 0)
      assert.equal(s.enCurso.total, 3 * cfg.precioDia)
      assert.deepEqual(s.enCurso.ops.map(o => String(o.id)), [String(id)])
      assert.equal(s.total, 0) // todavía no es deuda
    })
  })

  describe('IVA quitado a un alquiler ya cargado', () => {
    it('la operación deja de deber el IVA; la deuda más vieja sigue igual', async () => {
      const cli = await datos.crearCliente({ cuentaCorriente: true })
      const vieja = await ventaCC(cli, { compra: '2026-01-10', neto: 1000 })
      const alq = await alquilerCobrado(cli, { dias: 3 })
      const neto = 3 * cfg.precioDia
      await FacturacionModel.marcar(alq)
      await FacturacionModel.quitar(alq)
      assert.equal(await saldo(cli), -(1000 + neto))
      // Antes el IVA quitado se aplicaba a la venta vieja: la mostraba pagada y al alquiler debiendo el IVA
      assert.equal((await opDe(cli, vieja)).resta, 1000)
      assert.equal((await opDe(cli, alq)).resta, neto)
      assert.equal((await opDe(cli, alq)).total, neto)
      assert.equal(await restaEnCuenta(cli, vieja), 1000)
    })
  })

  describe('saldo a favor', () => {
    it('una venta pagada con saldo a favor que no alcanza no se registra', async () => {
      const VentasController = require('../src/controllers/ventas.controller')
      const cli = await datos.crearCliente({ saldo: 1000 })
      const r = await llamar(VentasController, 'finalizarCantera', { user, body: {
        clienteId: String(cli), clienteNombre: 'PRUEBA', metodoPago: 'saldo_a_favor',
        items: JSON.stringify([{ id: producto, cantidad: 1, precioManual: true, precio: 5000 }]),
      } })
      assert.match(r.flashes.find(f => f.tipo === 'error').msg, /no alcanza para pagar \$5\.000/)
      assert.equal((await prueba.q(`SELECT 1 FROM op_encabezado WHERE id_cliente = ?`, [cli])).rowCount, 0)
      assert.equal(await saldo(cli), 1000)
    })

    it('si alcanza: consume el crédito y la operación figura pagada en todos lados', async () => {
      const cli = await datos.crearCliente({ saldo: 5000 })
      const id = await ventaCC(cli, { compra: '2026-10-05', neto: 3000, metodo: 'saldo_a_favor' })
      assert.equal(await saldo(cli), 2000)
      const op = await opDe(cli, id)
      assert.equal(op.estado, 'pagada')
      assert.equal(op.enCuenta, true)
      const s = (await liq(cli)).saldo
      assert.equal(s.cuenta.saldo, 2000)
      assert.equal(s.cuenta.aFavor, 2000)
      assert.equal(s.cuenta.creditos.reduce((t, c) => t + c.sobrante, 0), 2000)
    })

    it('un dato viejo que usó más saldo del que había: la Liquidación muestra lo que se debe, como la cuenta', async () => {
      const cli = await datos.crearCliente({ saldo: 1000 })
      const id = await ventaCC(cli, { compra: '2026-10-05', neto: 3000, metodo: 'saldo_a_favor' }) // sin pasar por el formulario
      assert.equal(await saldo(cli), -2000)
      const op = await opDe(cli, id)
      assert.equal(op.estado, 'parcial') // antes: "pagada"
      assert.equal(op.resta, 2000)
      assert.equal(op.resta, await restaEnCuenta(cli, id))
    })

    it('alquiler histórico pagado con saldo a favor: ahora descuenta el crédito (y la puesta en regla completa los viejos)', async () => {
      const cli = await datos.crearCliente({ saldo: 10000 })
      const id = await alquilerCobrado(cli, { metodo: 'saldo_a_favor', dias: 3 })
      assert.equal(await saldo(cli), 10000 - 3 * cfg.precioDia)
      // Uno viejo, cobrado sin descontar el crédito: la puesta en regla lo completa
      await prueba.q(`DELETE FROM movimientos_cuenta WHERE id_op_encabezado = ?`, [id])
      assert.equal(await saldo(cli), 10000)
      assert.equal(await AlquileresModel.sincronizarCargoCC(id), `cargo creado por ${3 * cfg.precioDia}`)
      assert.equal(await saldo(cli), 10000 - 3 * cfg.precioDia)
      assert.equal(await AlquileresModel.sincronizarCargoCC(id), null) // idempotente
    })

    it('"Pagos recibidos" no cuenta el uso de saldo a favor como plata que entró', async () => {
      const cli = await datos.crearCliente({ cuentaCorriente: true })
      await ClientesModel.agregarMovimiento(cli, { tipo: 'pago', descripcion: 'Adelanto', monto: 5000, metodo_pago: 'efectivo', fecha: `${HOY} 09:00:00` })
      await TransaccionesModel.crear({ tipo: 'Venta Cantera', cliente_id: cli, cliente: 'P', monto: 3000, metodo_pago: 'saldo_a_favor', fecha: `${HOY} 10:00:00` })
      const r = await LiquidacionesModel.liquidacion(normalizarFiltros({ clienteId: String(cli), desde: HOY, hasta: HOY }, HOY))
      assert.deepEqual(r.clientes[0].pagos.map(p => p.monto), [5000])
    })
  })

  describe('editar o cambiar el método de un alquiler ya cobrado', () => {
    it('contenedor: cambiar el precio corrige el cobro y el cargo', async () => {
      const cli = await datos.crearCliente({ cuentaCorriente: true })
      const id = await alquilerCobrado(cli, { dias: 3 })
      const a = await AlquileresModel.obtener(id)
      await AlquileresModel.actualizar(id, { calle: 'San Lorenzo', numero: '501', zona_entrega: '', plazo_alquiler: 4,
        precio_alquiler: '100000', metodo_pago: 'cuenta_corriente', observaciones: '', fecha_entrega_planificada: a.fecha_entrega_planificada })
      assert.deepEqual((await prueba.q(`SELECT monto FROM transacciones WHERE id_op_encabezado = ?`, [id])).rows.map(r => Number(r.monto)), [100000])
      assert.deepEqual(await cargosDe(id), [{ tipo: 'deuda', monto: -100000 }])
      assert.equal(await saldo(cli), -100000)
      assert.equal((await opDe(cli, id)).total, 100000)
    })

    it('contenedor: pasar de cuenta corriente a efectivo quita el cargo (con el IVA que tuviera)', async () => {
      const cli = await datos.crearCliente({ cuentaCorriente: true })
      const id = await alquilerCobrado(cli, { dias: 3 })
      await FacturacionModel.marcar(id) // le suma un cargo de IVA aparte
      assert.equal((await cargosDe(id)).length, 2)
      const a = await AlquileresModel.obtener(id)
      const cobro = await AlquileresModel.cobroRegistrado(id)
      await AlquileresModel.actualizar(id, { calle: 'San Lorenzo', numero: '501', zona_entrega: '', plazo_alquiler: 4,
        precio_alquiler: String(cobro.neto), metodo_pago: 'efectivo', observaciones: '', fecha_entrega_planificada: a.fecha_entrega_planificada })
      assert.deepEqual(await cargosDe(id), [])
      assert.equal(await saldo(cli), 0)
      const op = await opDe(cli, id)
      assert.equal(op.estado, 'pagada') // cobrado en efectivo
      assert.equal(op.enCuenta, false)
    })

    it('Transacciones → cambiar método de un alquiler: tampoco deja el IVA colgado', async () => {
      const cli = await datos.crearCliente({ cuentaCorriente: true })
      const id = await alquilerCobrado(cli, { dias: 3 })
      await FacturacionModel.marcar(id)
      const tx = (await prueba.q(`SELECT id FROM transacciones WHERE id_op_encabezado = ?`, [id])).rows[0].id
      await TransaccionesModel.cambiarMetodoPago(tx, 'efectivo')
      assert.deepEqual(await cargosDe(id), []) // antes quedaba el cargo del IVA
      assert.equal(await saldo(cli), 0)
      await TransaccionesModel.cambiarMetodoPago(tx, 'cuenta_corriente')
      const total = Number((await prueba.q(`SELECT monto FROM transacciones WHERE id = ?`, [tx])).rows[0].monto)
      assert.equal(await saldo(cli), -total)
    })

    it('a saldo a favor solo si alcanza', async () => {
      const cli = await datos.crearCliente({ cuentaCorriente: true, saldo: 1000 })
      const id = await alquilerCobrado(cli, { dias: 3, metodo: 'efectivo' })
      const tx = (await prueba.q(`SELECT id FROM transacciones WHERE id_op_encabezado = ?`, [id])).rows[0].id
      await assert.rejects(TransaccionesModel.cambiarMetodoPago(tx, 'saldo_a_favor'), /no alcanza/)
      assert.equal(await saldo(cli), 1000)
    })

    it('maquinaria: cambiar el precio después de iniciado corrige el cobro y el cargo', async () => {
      const MaqController = require('../src/controllers/alquileres_maquinaria.controller')
      const cli = await datos.crearCliente({ cuentaCorriente: true })
      const maq = (await prueba.q(`INSERT INTO maquinaria (nombre) VALUES ('Bobcat prueba') RETURNING id`)).rows[0].id
      const { id } = await AlquileresMaquinariaModel.crear({ id_cliente: cli, id_administrativo: admin, domicilio_entrega: 'Colón 1',
        plazo_alquiler: 1, precio_por_hora: 10000, horas_pactadas: 5, precio_total: 50000, id_maquinaria: maq, metodo_pago: 'cuenta_corriente' })
      await llamar(MaqController, 'entregar', { user, params: { id } })
      assert.equal(await saldo(cli), -50000)
      await AlquileresMaquinariaModel.actualizar(id, { calle: 'Colón', numero: '1', zona_entrega: '', plazo_alquiler: 1, precio_por_hora: 12000,
        horas_pactadas: 5, precio_total: 60000, metodo_pago: 'cuenta_corriente', observaciones: '' })
      assert.equal(await saldo(cli), -60000)
      assert.equal((await opDe(cli, id)).total, 60000)
      assert.equal((await opDe(cli, id)).resta, await restaEnCuenta(cli, id))
    })

    it('borrar la transacción de una venta pagada con saldo a favor devuelve el crédito', async () => {
      const cli = await datos.crearCliente({ saldo: 5000 })
      const id = await ventaCC(cli, { compra: '2026-10-05', neto: 3000, metodo: 'saldo_a_favor' })
      const tx = await TransaccionesModel.crear({ tipo: 'Venta Viaje', id_op_encabezado: id, cliente_id: cli, monto: 3000, metodo_pago: 'saldo_a_favor' })
      await TransaccionesModel.eliminar(tx) // antes: error de FK por el uso de saldo a favor
      assert.equal(await saldo(cli), 5000)
    })
  })

  describe('puesta en regla y revisión (npm run revisar:saldos)', () => {
    it('detecta un cargo que no coincide con la venta y un alquiler con métodos distintos; la puesta en regla corrige el primero', async () => {
      process.env.SALDOS_SIN_SIMULAR = '1' // el arnés ya corre todo dentro de una transacción
      const revisar = require('../scripts/revisar-saldos')
      const cli = await datos.crearCliente({ cuentaCorriente: true })
      const venta = await ventaCC(cli, { compra: '2026-10-05', neto: 3000 })
      await prueba.q(`UPDATE movimientos_cuenta SET monto = -2500 WHERE id_op_encabezado = ?`, [venta]) // dato viejo descuadrado
      const alq = await alquilerCobrado(cli, { dias: 3 })
      await prueba.q(`UPDATE op_encabezado SET metodo_pago = 'efectivo' WHERE id = ?`, [alq]) // editado sin acompañar el cobro
      const nro = async (id) => `OP-${String((await prueba.q(`SELECT nro_op FROM op_encabezado WHERE id = ?`, [id])).rows[0].nro_op).padStart(4, '0')}`
      const [nroVenta, nroAlq] = [await nro(venta), await nro(alq)]
      const { cambios, revisar: aRevisar } = await revisar.cargosACorregir()
      assert.ok(cambios.some(c => c.startsWith(`${nroVenta} (venta): cargo ajustado a 3000`)), JSON.stringify(cambios))
      assert.ok(aRevisar.includes(nroAlq))
      // La venta quedó corregida (sin simular); el alquiler ambiguo no se tocó
      assert.equal(await saldo(cli), -(3000 + 3 * cfg.precioDia))
      assert.equal((await opDe(cli, venta)).resta, await restaEnCuenta(cli, venta))
      delete process.env.SALDOS_SIN_SIMULAR
    })

    it('un cargo a mano vinculado por error a una venta no se borra: se desvincula y el saldo no cambia', async () => {
      const cli = await datos.crearCliente({ cuentaCorriente: true })
      const venta = await ventaCC(cli, { compra: '2026-10-05', neto: 50000 })
      const manual = await ClientesModel.agregarMovimiento(cli, { tipo: 'deuda', descripcion: 'Cargo manual', monto: -50000 })
      await prueba.q(`UPDATE movimientos_cuenta SET id_op_encabezado = ? WHERE id = ?`, [venta, manual]) // lo que hacía el vínculo viejo
      assert.equal(await VentasModel.sincronizarCargoCC(venta), 'cargo a mano desvinculado')
      assert.equal(await saldo(cli), -100000)
      const m = (await prueba.q(`SELECT id_op_encabezado FROM movimientos_cuenta WHERE id = ?`, [manual])).rows[0]
      assert.equal(m.id_op_encabezado, null)
      assert.equal((await LiquidacionesModel.saldoCliente(cli)).cuenta.desglose.manuales, 50000)
    })

    it('alquileres al arrancar: completa el que falta, desvincula cargos a mano y no toca importes dudosos', async () => {
      const cli = await datos.crearCliente({ cuentaCorriente: true })
      const conservador = { conservador: true }
      // Cargo a mano vinculado por error: se desvincula
      const a = await alquilerCobrado(cli, { dias: 3 })
      const manual = await ClientesModel.agregarMovimiento(cli, { tipo: 'deuda', descripcion: 'Saldo de obra', monto: -7000, id_op_encabezado: a })
      assert.equal(await AlquileresModel.sincronizarCargoCC(a, undefined, conservador), 'cargo a mano desvinculado')
      assert.equal((await prueba.q(`SELECT id_op_encabezado FROM movimientos_cuenta WHERE id = ?`, [manual])).rows[0].id_op_encabezado, null)
      // Importe distinto de lo cobrado sin explicación: no lo toca, lo informa
      const b = await alquilerCobrado(cli, { dias: 4 })
      await prueba.q(`UPDATE movimientos_cuenta SET monto = -1 WHERE id_op_encabezado = ?`, [b])
      const antes = await saldo(cli)
      assert.equal(await AlquileresModel.sincronizarCargoCC(b, undefined, conservador), 'revisar')
      assert.equal(await saldo(cli), antes)
      // Al editarlo (a pedido del usuario) sí se corrige
      assert.match(await AlquileresModel.sincronizarCargoCC(b), /cargo ajustado/)
      assert.equal(await restaEnCuenta(cli, b), 4 * cfg.precioDia)
    })
  })

  describe('todo el cliente cierra', () => {
    it('lo que falta de cada operación en la Liquidación suma la deuda de la cuenta corriente', async () => {
      const cli = await datos.crearCliente({ cuentaCorriente: true })
      await ventaCC(cli, { compra: '2026-08-10', neto: 70000 })
      await alquilerCobrado(cli, { dias: 3 })
      await alquilerCobrado(cli, { dias: 5, montoAlCerrar: '99999.99' })
      await ClientesModel.agregarMovimiento(cli, { tipo: 'pago', descripcion: 'Pago', monto: 85000, metodo_pago: 'transferencia' })
      await ClientesModel.agregarMovimiento(cli, { tipo: 'deuda', descripcion: 'Cargo a mano', monto: -1500 })
      const r = await liq(cli)
      const enCuenta = r.clientes[0].operaciones.filter(o => o.enCuenta)
      const resta = Math.round(enCuenta.reduce((s, o) => s + o.resta, 0) * 100) / 100
      assert.equal(Math.round((resta + r.saldo.cuenta.desglose.manuales) * 100) / 100, -(await saldo(cli)))
      assert.equal(r.saldo.cuenta.saldo, await saldo(cli))
      assert.equal(r.saldo.cuenta.coincideConMovimientos, true)
      for (const o of enCuenta) assert.equal(o.resta, await restaEnCuenta(cli, o.id), `OP ${o.nro_op}`)
    })
  })
})
