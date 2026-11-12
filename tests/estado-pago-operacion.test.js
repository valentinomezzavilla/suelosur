'use strict'
// Marcar pendiente / marcar pagada una operación (models/estadoPago.model.js).
// Corre dentro de la transacción de prueba (ROLLBACK al final: nada queda guardado).
const prueba = require('./helpers/db')
const datos = require('./helpers/datos')
const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { imputar } = require('../src/utils/imputacion')
const EstadoPago = require('../src/models/estadoPago.model')
const ClientesModel = require('../src/models/clientes.model')
const LiquidacionesModel = require('../src/models/liquidaciones.model')
const VentasModel = require('../src/models/ventas.model')
const TransaccionesModel = require('../src/models/transacciones.model')
const { normalizarFiltros } = require('../src/utils/liquidaciones')
const { hoyISO } = require('../src/utils/fecha')

const HOY = hoyISO()
const mov = (id, monto, extra = {}) => ({ id, monto, tipo: monto < 0 ? 'deuda' : 'pago', id_op_encabezado: null, ...extra })

describe('calcularReversion (lógica pura)', () => {
  it('un pago elegido para una sola operación se anula entero', () => {
    const movs = [mov(1, -500, { id_op_encabezado: 10 }), mov(2, -500, { id_op_encabezado: 20 }), mov(3, 500)]
    const r = EstadoPago.calcularReversion(movs, [{ id_pago: 3, id_op_encabezado: 20, monto: 500 }], 20)
    assert.deepEqual(r.cambios.map(c => [c.idPago, c.montoNuevo, c.tocaMonto]), [[3, 0, true]])
  })

  it('un pago que cubría dos operaciones queda por la otra, escrito a ella', () => {
    const movs = [mov(1, -500, { id_op_encabezado: 10 }), mov(2, -500, { id_op_encabezado: 20 }), mov(3, 1000)]
    const asig = [{ id_pago: 3, id_op_encabezado: 10, monto: 500 }, { id_pago: 3, id_op_encabezado: 20, monto: 500 }]
    const r = EstadoPago.calcularReversion(movs, asig, 20)
    assert.equal(r.cambios.length, 1)
    assert.equal(r.cambios[0].montoNuevo, 500)
    assert.deepEqual(r.cambios[0].imputaciones.map(i => [i.idOp, i.monto]), [[10, 500]])
  })

  it('pago a lo más viejo (sin elegir): al quitar la más vieja, la siguiente sigue pagada', () => {
    const movs = [mov(1, -500, { id_op_encabezado: 10 }), mov(2, -500, { id_op_encabezado: 20 }), mov(3, 700)]
    const r = EstadoPago.calcularReversion(movs, [], 10)
    // Quedan los 200 que pagaban la 20, escritos a ella (si no, volverían a la 10, la más vieja)
    assert.equal(r.cambios[0].montoNuevo, 200)
    assert.deepEqual(r.cambios[0].imputaciones.map(i => [i.idOp, i.monto]), [[20, 200]])
  })

  it('el saldo a favor que volvería a cubrir la operación también se quita', () => {
    const movs = [mov(1, -600, { id_op_encabezado: 10 }), mov(2, 1000)]
    const r = EstadoPago.calcularReversion(movs, [], 10)
    assert.equal(r.cambios[0].montoNuevo, 0)
  })

  it('una operación sin pagos aplicados no tiene nada que cambiar', () => {
    const r = EstadoPago.calcularReversion([mov(1, -600, { id_op_encabezado: 10 })], [], 10)
    assert.deepEqual(r.cambios, [])
  })

  it('otro pago a lo más viejo no cambia de destino al quedar la operación pendiente', () => {
    // La 10 la pagaba el pago 3 (elegido); el pago 5 (FIFO) pagaba la 20. Sin el pago 3, el
    // pago 5 cubriría la 10 (la más vieja): hay que dejarlo escrito para la 20.
    const movs = [mov(1, -500, { id_op_encabezado: 10 }), mov(2, 500), mov(3, -500, { id_op_encabezado: 20 }), mov(4, 500)]
    const asig = [{ id_pago: 2, id_op_encabezado: 10, monto: 500 }]
    const base = imputar(movs, asig)
    assert.equal(base.cargos[1].restante, 0)
    assert.equal(base.cargos[3].restante, 0)
    const r = EstadoPago.calcularReversion(movs, asig, 10)
    const c4 = r.cambios.find(c => c.idPago === 4)
    assert.ok(c4, 'el pago 4 debe quedar escrito a la operación 20')
    assert.equal(c4.tocaMonto, false)
    assert.deepEqual(c4.imputaciones.map(i => [i.idOp, i.monto]), [[20, 500]])
  })
})

describe('marcar pendiente / pagada en la base', () => {
  let admin, producto, user
  before(async () => {
    await prueba.abrir()
    admin = await datos.idAdministrativo()
    user = { id: admin, rol: 'dueno' }
    producto = (await prueba.q(`SELECT id FROM productos WHERE COALESCE(es_contenedor,0)=0 ORDER BY id LIMIT 1`)).rows[0].id
  })
  after(() => prueba.cerrar())

  const venta = async (cliente, compra, neto, metodo = 'cuenta_corriente') => {
    const id = (await VentasModel.crear({
      id_cliente: cliente, id_administrativo: admin, tipo_op: 'M', modalidad: 'deposito', metodo_pago: metodo,
      fecha_emision: compra, monto_total: neto, detalles: [{ id_producto: producto, cantidad_pedida: 1, precio_unitario: neto }],
    })).id
    if (metodo === 'cuenta_corriente') await VentasModel.sincronizarCargoCC(id)
    return id
  }
  const pagar = async (cliente, monto, imputaciones = [], fecha = HOY + ' 12:00:00') => {
    const elegidas = await ClientesModel.validarImputaciones(cliente, imputaciones, monto)
    const id = await ClientesModel.agregarMovimiento(cliente, { tipo: 'pago', descripcion: 'Pago', monto, metodo_pago: 'transferencia', fecha })
    await ClientesModel.guardarImputaciones(id, elegidas)
    return id
  }
  const estados = async (cliente) => Object.fromEntries((await LiquidacionesModel.liquidacion(
    normalizarFiltros({ clienteId: String(cliente), desde: '2000-01-01', hasta: '2099-12-31' }, HOY))).clientes[0].operaciones.map(o => [String(o.id), o.estado]))
  const saldo = async (id) => Number((await prueba.q(`SELECT saldo FROM clientes WHERE id = ?`, [id])).rows[0].saldo)

  it('un pago elegido para una operación: queda pendiente, el saldo baja y el pago figura anulado con el motivo', async () => {
    const cli = await datos.crearCliente({ cuentaCorriente: true })
    const v1 = await venta(cli, '2026-09-10', 500000)
    const v2 = await venta(cli, '2026-10-10', 500000)
    const pago = await pagar(cli, 500000, [{ clave: `op:${v2}`, monto: 500000 }])
    assert.deepEqual(await estados(cli), { [v1]: 'pendiente', [v2]: 'pagada' })
    assert.equal(await saldo(cli), -500000)

    const previa = await EstadoPago.vistaPreviaPendiente(v2)
    assert.equal(previa.puede, true)
    assert.equal(previa.saldoAntes, -500000)
    assert.equal(previa.saldoDespues, -1000000)

    await EstadoPago.marcarPendiente(v2, { usuario: admin, motivo: 'No llegó la transferencia' })
    assert.deepEqual(await estados(cli), { [v1]: 'pendiente', [v2]: 'pendiente' })
    assert.equal(await saldo(cli), -1000000)
    const p = (await prueba.q(`SELECT anulado, anulado_motivo FROM movimientos_cuenta WHERE id = ?`, [pago])).rows[0]
    assert.equal(Number(p.anulado), 1)
    assert.match(p.anulado_motivo, /No llegó la transferencia/)
    // En Ventas / Transacciones también figura sin saldar
    assert.deepEqual(await ClientesModel.saldadaPorOperacion([v1, v2]), { [v1]: false, [v2]: false })
  })

  it('un pago que cubría dos operaciones se rehace por la otra y nada más cambia', async () => {
    const cli = await datos.crearCliente({ cuentaCorriente: true })
    const v1 = await venta(cli, '2026-09-10', 500000)
    const v2 = await venta(cli, '2026-10-10', 500000)
    const v3 = await venta(cli, '2026-11-02', 500000)
    await pagar(cli, 1000000, [{ clave: `op:${v3}`, monto: 500000 }, { clave: `op:${v2}`, monto: 500000 }])
    assert.deepEqual(await estados(cli), { [v1]: 'pendiente', [v2]: 'pagada', [v3]: 'pagada' })

    await EstadoPago.marcarPendiente(v3, { usuario: admin, motivo: 'Error de carga' })
    assert.deepEqual(await estados(cli), { [v1]: 'pendiente', [v2]: 'pagada', [v3]: 'pendiente' })
    assert.equal(await saldo(cli), -1000000)
    const vigentes = (await prueba.q(`SELECT monto, descripcion FROM movimientos_cuenta WHERE cliente_id = ? AND tipo = 'pago' AND COALESCE(anulado,0) = 0`, [cli])).rows
    assert.equal(vigentes.length, 1)
    assert.equal(Number(vigentes[0].monto), 500000)
    assert.match(vigentes[0].descripcion, /resto tras marcar pendiente/)
  })

  it('un pago sin elegir (a lo más viejo): al dejar pendiente la vieja, la siguiente sigue como estaba', async () => {
    const cli = await datos.crearCliente({ cuentaCorriente: true })
    const v1 = await venta(cli, '2026-09-10', 500000)
    const v2 = await venta(cli, '2026-10-10', 500000)
    await pagar(cli, 700000)
    assert.deepEqual(await estados(cli), { [v1]: 'pagada', [v2]: 'parcial' })

    await EstadoPago.marcarPendiente(v1, { usuario: admin, motivo: 'No estaba pagada' })
    assert.deepEqual(await estados(cli), { [v1]: 'pendiente', [v2]: 'parcial' })
    assert.equal(await saldo(cli), -800000)
  })

  it('con saldo a favor que volvería a cubrirla, se quita también: queda pendiente de verdad', async () => {
    const cli = await datos.crearCliente({ cuentaCorriente: true })
    const v1 = await venta(cli, '2026-10-10', 600000)
    await pagar(cli, 1000000)
    assert.equal(await saldo(cli), 400000)
    await EstadoPago.marcarPendiente(v1, { usuario: admin, motivo: 'Pago mal cargado' })
    assert.deepEqual(await estados(cli), { [v1]: 'pendiente' })
    assert.equal(await saldo(cli), -600000)
  })

  it('exige motivo, y una operación ya pendiente no tiene nada que revertir', async () => {
    const cli = await datos.crearCliente({ cuentaCorriente: true })
    const v1 = await venta(cli, '2026-10-10', 100000)
    await assert.rejects(() => EstadoPago.marcarPendiente(v1, { usuario: admin, motivo: ' ' }), /motivo/)
    await assert.rejects(() => EstadoPago.marcarPendiente(v1, { usuario: admin, motivo: 'prueba' }), /ya está pendiente/)
    assert.equal(await saldo(cli), -100000)
  })

  it('un pago de cheque no se toca desde acá', async () => {
    const cli = await datos.crearCliente({ cuentaCorriente: true })
    const v1 = await venta(cli, '2026-10-10', 100000)
    const pago = await pagar(cli, 100000, [{ clave: `op:${v1}`, monto: 100000 }])
    await prueba.q(`INSERT INTO cheques (tipo_cartera, monto, estado, id_cliente, id_mov_cuenta) VALUES ('recibido', 100000, 'habilitado', ?, ?)`, [cli, pago])
    const previa = await EstadoPago.vistaPreviaPendiente(v1)
    assert.equal(previa.puede, false)
    assert.match(previa.bloqueos[0], /cheque/)
    await assert.rejects(() => EstadoPago.marcarPendiente(v1, { usuario: admin, motivo: 'prueba' }), /cheque/)
    assert.equal((await estados(cli))[v1], 'pagada')
  })

  it('venta cobrada de contado: pasa a cuenta corriente y el cliente la debe', async () => {
    const cli = await datos.crearCliente({ cuentaCorriente: true })
    const v1 = await venta(cli, '2026-10-10', 200000, 'efectivo')
    await prueba.q(`UPDATE op_encabezado SET estado = 'entregado' WHERE id = ?`, [v1])
    await TransaccionesModel.crear({ tipo: 'Venta Cantera', id_op_encabezado: v1, cliente_id: cli, monto: 200000, metodo_pago: 'efectivo' })
    assert.equal((await estados(cli))[v1], 'pagada')
    assert.equal(await saldo(cli), 0)

    const previa = await EstadoPago.vistaPreviaPendiente(v1)
    assert.equal(previa.puede, true)
    assert.equal(previa.saldoDespues, -200000)
    await EstadoPago.marcarPendiente(v1, { usuario: admin, motivo: 'No pagó' })
    assert.equal((await estados(cli))[v1], 'pendiente')
    assert.equal(await saldo(cli), -200000)
    assert.deepEqual(await ClientesModel.saldadaPorOperacion([v1]), { [v1]: false })
  })

  it('venta cobrada de contado a un cliente sin cuenta corriente: se explica por qué no se puede', async () => {
    const cli = await datos.crearCliente({ cuentaCorriente: false })
    const v1 = await venta(cli, '2026-10-10', 200000, 'efectivo')
    await TransaccionesModel.crear({ tipo: 'Venta Cantera', id_op_encabezado: v1, cliente_id: cli, monto: 200000, metodo_pago: 'efectivo' })
    const previa = await EstadoPago.vistaPreviaPendiente(v1)
    assert.equal(previa.puede, false)
    assert.match(previa.bloqueos[0], /cuenta corriente/)
    await assert.rejects(() => EstadoPago.marcarPendiente(v1, { usuario: admin, motivo: 'prueba' }), /cuenta corriente/)
    assert.equal((await estados(cli))[v1], 'pagada')
  })

  it('marcar pagada una venta de contado entregada sin cobro: registra el cobro por lo que falta', async () => {
    const cli = await datos.crearCliente({ cuentaCorriente: false })
    const v1 = await venta(cli, '2026-10-10', 350000, 'efectivo')
    await prueba.q(`UPDATE op_encabezado SET estado = 'entregado' WHERE id = ?`, [v1])
    assert.equal((await estados(cli))[v1], 'pendiente')

    const previa = await EstadoPago.vistaPreviaPagada(v1, { metodo_pago: 'transferencia' })
    assert.equal(previa.puede, true)
    assert.equal(previa.monto, 350000)
    await EstadoPago.marcarPagada(v1, { usuario: admin, metodo_pago: 'transferencia', fechaDia: '2026-10-12' })
    assert.equal((await estados(cli))[v1], 'pagada')
    const t = (await prueba.q(`SELECT monto, metodo_pago, fecha FROM transacciones WHERE id_op_encabezado = ?`, [v1])).rows
    assert.equal(t.length, 1)
    assert.equal(Number(t[0].monto), 350000)
    assert.equal(t[0].metodo_pago, 'transferencia')
    assert.match(String(t[0].fecha), /^2026-10-12/)
    await assert.rejects(() => EstadoPago.marcarPagada(v1, { usuario: admin, metodo_pago: 'efectivo' }), /ya está pagada/)
  })

  it('no se marca pagada una venta que todavía no se entregó, ni con cheque', async () => {
    const cli = await datos.crearCliente({ cuentaCorriente: true })
    const v1 = await venta(cli, '2026-10-10', 100000, 'efectivo')
    const v2 = await venta(cli, '2026-10-10', 100000)
    await prueba.q(`UPDATE op_encabezado SET estado = 'pendiente' WHERE id = ?`, [v1])
    const a = await EstadoPago.vistaPreviaPagada(v1)
    assert.equal(a.puede, false)
    assert.match(a.bloqueos[0], /entreg/)
    // En cuenta corriente sí se puede (registra el pago), pero no con cheque
    const b = await EstadoPago.vistaPreviaPagada(v2, { metodo_pago: 'cheque' })
    assert.equal(b.puede, false)
    assert.match(b.bloqueos[0], /efectivo o transferencia/)
    assert.equal((await EstadoPago.vistaPreviaPagada(v2)).puede, true)
  })

  it('una auditoría deja registro de quién y por qué', async () => {
    const cli = await datos.crearCliente({ cuentaCorriente: true })
    const v1 = await venta(cli, '2026-10-10', 100000)
    await pagar(cli, 100000, [{ clave: `op:${v1}`, monto: 100000 }])
    await EstadoPago.marcarPendiente(v1, { usuario: admin, motivo: 'Auditoría de prueba' })
    const a = (await prueba.q(`SELECT accion, detalle FROM auditoria WHERE entidad_tipo = 'operacion' AND entidad_id = ?`, [String(v1)])).rows
    assert.equal(a.length, 1)
    assert.equal(a[0].accion, 'marcar_pendiente')
    assert.match(a[0].detalle, /Auditoría de prueba/)
  })

// ── Controlador y pantallas ────────────────────────────────────────────
const EstadoPagoController = require('../src/controllers/estadoPago.controller')
const ClientesController = require('../src/controllers/clientes.controller')
const LiquidacionesController = require('../src/controllers/liquidaciones.controller')
const { renderVista } = require('./helpers/vistas')

describe('controlador y pantallas de marcar pendiente / pagada', () => {
  function llamar(controlador, accion, { body = {}, params = {}, query = {} }) {
    return new Promise((resolve, reject) => {
      const flashes = []
      const req = { body, params, query, baseUrl: '', session: { user }, flash: (tipo, msg) => flashes.push({ tipo, msg }), get: () => null }
      const res = {
        redirect: (url) => resolve({ url, flashes }), render: (vista, data) => resolve({ vista, data, flashes }),
        json: (data) => resolve({ json: data, flashes }), status(c) { this.codigo = c; return this },
      }
      Promise.resolve(controlador[accion](req, res)).catch(reject)
    })
  }
  const venta = async (cliente, compra, neto, metodo = 'cuenta_corriente') => {
    const id = (await VentasModel.crear({
      id_cliente: cliente, id_administrativo: admin, tipo_op: 'M', modalidad: 'deposito', metodo_pago: metodo,
      fecha_emision: compra, monto_total: neto, detalles: [{ id_producto: producto, cantidad_pedida: 1, precio_unitario: neto }],
    })).id
    if (metodo === 'cuenta_corriente') await VentasModel.sincronizarCargoCC(id)
    return id
  }
  const pagar = async (cliente, monto, imputaciones = []) => {
    const elegidas = await ClientesModel.validarImputaciones(cliente, imputaciones, monto)
    const id = await ClientesModel.agregarMovimiento(cliente, { tipo: 'pago', descripcion: 'Pago', monto, metodo_pago: 'transferencia' })
    await ClientesModel.guardarImputaciones(id, elegidas)
    return id
  }

  it('la vista previa y la confirmación por el controlador', async () => {
    const cli = await datos.crearCliente({ cuentaCorriente: true })
    const v1 = await venta(cli, '2026-10-10', 200000)
    await pagar(cli, 200000, [{ clave: `op:${v1}`, monto: 200000 }])
    const previa = await llamar(EstadoPagoController, 'vistaPrevia', { params: { id: v1 }, query: { accion: 'pendiente' } })
    assert.equal(previa.json.puede, true)
    assert.equal(previa.json.saldoAntes, 0)
    assert.equal(previa.json.saldoDespues, -200000)
    // sin motivo no se guarda
    let r = await llamar(EstadoPagoController, 'marcarPendiente', { params: { id: v1 }, body: { motivo: '' } })
    assert.equal(r.flashes[0].tipo, 'error')
    assert.equal(Number((await prueba.q(`SELECT saldo FROM clientes WHERE id = ?`, [cli])).rows[0].saldo), 0)
    r = await llamar(EstadoPagoController, 'marcarPendiente', { params: { id: v1 }, body: { motivo: 'No pagó' } })
    assert.equal(r.flashes[0].tipo, 'success', JSON.stringify(r.flashes))
    assert.match(r.flashes[0].msg, /pendiente de pago/)
    assert.equal(Number((await prueba.q(`SELECT saldo FROM clientes WHERE id = ?`, [cli])).rows[0].saldo), -200000)
  })

  it('la cuenta corriente ofrece "Marcar pendiente" solo en las operaciones con algo pagado', async () => {
    const cli = await datos.crearCliente({ cuentaCorriente: true })
    const v1 = await venta(cli, '2026-10-05', 300000)
    const v2 = await venta(cli, '2026-10-20', 300000)
    await pagar(cli, 300000, [{ clave: `op:${v2}`, monto: 300000 }])
    const r = await llamar(ClientesController, 'cuentaDetalle', { params: { id: cli }, query: { desde: '2026-10-01' } })
    const html = await renderVista('pages/clientes/cuenta_detalle', { ...r.data, user })
    assert.match(html, new RegExp(`data-id="${v2}" data-accion="pendiente"`))
    assert.doesNotMatch(html, new RegExp(`data-id="${v1}" data-accion="pendiente"`))
    assert.match(html, new RegExp(`data-clave="op:${v1}"`))        // la pendiente: "Marcar como pagada"
    assert.match(html, /Marcar como pagada/)
    assert.match(html, /id="modal-estado-pago"/)
    // un usuario sin permiso para anular no ve el botón
    const sin = await renderVista('pages/clientes/cuenta_detalle', { ...r.data, user: { rol: 'admin_ventas' } })
    assert.doesNotMatch(sin, /data-accion="pendiente"/)
  })

  it('Liquidaciones ofrece marcar pendiente / pagada según el estado de cada operación', async () => {
    const cli = await datos.crearCliente({ cuentaCorriente: true })
    const vCC = await venta(cli, '2026-10-05', 300000)
    await pagar(cli, 300000, [{ clave: `op:${vCC}`, monto: 300000 }])
    const vContado = await venta(cli, '2026-10-06', 120000, 'efectivo')
    await prueba.q(`UPDATE op_encabezado SET estado = 'entregado' WHERE id = ?`, [vContado])
    const r = await llamar(LiquidacionesController, 'index', { query: { clienteId: String(cli), desde: '2026-10-01', hasta: '2026-10-31' } })
    const html = await renderVista('pages/liquidaciones/index', { ...r.data, user })
    assert.match(html, new RegExp(`data-id="${vCC}" data-accion="pendiente"`))
    assert.doesNotMatch(html, new RegExp(`data-id="${vCC}" data-accion="pagada"`))
    assert.match(html, new RegExp(`data-id="${vContado}" data-accion="pagada"`))
    assert.doesNotMatch(html, new RegExp(`data-id="${vContado}" data-accion="pendiente"`))
    assert.match(html, /id="modal-estado-pago"/)
  })
})

  describe('reporte revisar:pagos (solo lectura)', () => {
    const Reporte = require('../scripts/revisar-pagos')

    it('marca lo cubierto por un pago anterior a la operación aplicado solo, y lo cubierto por un ajuste a mano', async () => {
      const a = await datos.crearCliente({ cuentaCorriente: true })
      const vA = await venta(a, '2026-10-10', 100000)
      await ClientesModel.agregarMovimiento(a, { tipo: 'pago', descripcion: 'Pago viejo', monto: 100000, metodo_pago: 'efectivo', fecha: '2026-10-01 12:00:00' })
      const dudosasA = await Reporte.cubiertasDudosas(a)
      assert.deepEqual(dudosasA.map(h => [h.idOp, h.pagos[0].motivo]), [[vA, 'pago anterior a la operación, aplicado solo a lo más viejo']])

      const b = await datos.crearCliente({ cuentaCorriente: true })
      const vB = await venta(b, '2026-10-10', 200000)
      await ClientesModel.agregarMovimiento(b, { tipo: 'ajuste', descripcion: 'Ajuste a favor', monto: 200000, fecha: '2026-10-11 12:00:00' })
      const dudosasB = await Reporte.cubiertasDudosas(b)
      assert.deepEqual(dudosasB.map(h => [h.idOp, h.pagos[0].motivo]), [[vB, 'ajuste a favor cargado a mano']])
    })

    it('un pago elegido para la operación o hecho después de ella no es dudoso', async () => {
      const c = await datos.crearCliente({ cuentaCorriente: true })
      const v1 = await venta(c, '2026-10-10', 100000)
      const elegidas = await ClientesModel.validarImputaciones(c, [{ clave: 'op:' + v1, monto: 100000 }], 100000)
      const id = await ClientesModel.agregarMovimiento(c, { tipo: 'pago', descripcion: 'Pago', monto: 100000, metodo_pago: 'efectivo', fecha: '2026-10-01 12:00:00' })
      await ClientesModel.guardarImputaciones(id, elegidas)
      assert.deepEqual(await Reporte.cubiertasDudosas(c), [])
      const d = await datos.crearCliente({ cuentaCorriente: true })
      await venta(d, '2026-10-10', 100000)
      await ClientesModel.agregarMovimiento(d, { tipo: 'pago', descripcion: 'Pago', monto: 100000, metodo_pago: 'efectivo', fecha: '2026-10-20 12:00:00' })
      assert.deepEqual(await Reporte.cubiertasDudosas(d), [])
    })

    it('lista las ventas en cuenta sin cargo y las de contado entregadas sin cobro', async () => {
      const c = await datos.crearCliente({ cuentaCorriente: true })
      const sinCargo = await venta(c, '2026-10-10', 100000)      // creada sin sincronizar el cargo
      await prueba.q(`DELETE FROM movimientos_cuenta WHERE id_op_encabezado = ?`, [sinCargo])
      const sinCobro = await venta(c, '2026-10-11', 50000, 'efectivo')
      await prueba.q(`UPDATE op_encabezado SET estado = 'entregado' WHERE id = ?`, [sinCobro])
      assert.deepEqual((await Reporte.ventasSinCargo(c)).map(o => o.id), [sinCargo])
      assert.deepEqual((await Reporte.contadoSinCobro(c)).map(o => o.id), [sinCobro])
    })

    it('detalle de un cliente: pagos "para una operación" que en realidad se aplicaron a las más viejas', async () => {
      // Caso de la captura: se "salda" varias veces la misma operación y el pago se aplica solo a
      // lo más viejo, así que la operación sigue debiendo lo mismo y se vuelve a pagar
      const c = await datos.crearCliente({ cuentaCorriente: true })
      const vieja = await venta(c, '2026-09-10', 600000)
      const nueva = await venta(c, '2026-10-20', 336000)
      for (let i = 0; i < 2; i++) {
        await ClientesModel.agregarMovimiento(c, { tipo: 'pago', descripcion: 'Pago — Venta Viaje (la nueva)', monto: 336000, metodo_pago: 'efectivo', fecha: '2026-11-06 12:00:00' })
      }
      const d = await Reporte.detalleCliente(c)
      assert.equal(d.pagos.length, 2)
      // los dos pagos fueron a la operación VIEJA (a lo más viejo), ninguno a la que se quiso saldar
      const etiquetas = d.pagos.flatMap(p => p.aplicado.map(a => [a.etiqueta, a.elegida]))
      const nro = (id) => 'OP-' + String(d.operaciones.find(o => o.idOp === id).nro_op).padStart(4, '0')
      assert.ok(etiquetas.some(([e, el]) => e === nro(vieja) && el === false))
      const opNueva = d.operaciones.find(o => o.idOp === nueva)
      assert.ok(opNueva.pagado < opNueva.total, 'la operación nueva sigue sin pagar del todo')
      assert.equal(await Reporte.detalleCliente(999999999), null)
    })

    it('busca clientes por nombre o por N° de cliente (el id interno no es el N°)', async () => {
      const c = await datos.crearCliente({ cuentaCorriente: true })
      const numero = 987654   // el N° de cliente lo asigna el modelo al crear: acá se fija a mano
      await prueba.q(`UPDATE clientes SET nombre = 'CO.C', apellido = 'STUDIO ZZ', numero = ? WHERE id = ?`, [numero, c])
      assert.deepEqual((await Reporte.buscarClientes('co.c studio zz')).map(x => x.id), [c])
      assert.deepEqual((await Reporte.buscarClientes('STUDIO ZZ')).map(x => x.id), [c])
      assert.ok((await Reporte.buscarClientes(String(numero))).some(x => x.id === c))
      assert.deepEqual(await Reporte.buscarClientes('   '), [])
      assert.deepEqual(await Reporte.buscarClientes('nadie-se-llama-asi-xyz'), [])
    })
  })

  describe('marcar como pagada en cuenta corriente y botones en los demás módulos', () => {
    const { accionesDe } = require('../src/utils/estadoPagoAcciones')
    const VentasController = require('../src/controllers/ventas.controller')
    const TransaccionesController = require('../src/controllers/transacciones.controller')

    function llamarCtl(controlador, accion, { body = {}, params = {}, query = {} } = {}) {
      return new Promise((resolve, reject) => {
        const flashes = []
        const req = { body, params, query, baseUrl: '', session: { user }, flash: (tipo, msg) => flashes.push({ tipo, msg }), get: () => null }
        const res = {
          redirect: (url) => resolve({ url, flashes }), render: (vista, data) => resolve({ vista, data, flashes }),
          json: (data) => resolve({ json: data, flashes }), status() { return this },
        }
        Promise.resolve(controlador[accion](req, res)).catch(reject)
      })
    }

    it('accionesDe: cada estado ofrece lo que corresponde', () => {
      const base = { resta: 100, metodo_pago: 'efectivo', estadoOp: 'entregado' }
      assert.deepEqual(accionesDe({ ...base, estado: 'pagada', resta: 0 }), { pendiente: true, pagada: false })
      assert.deepEqual(accionesDe({ ...base, estado: 'parcial' }), { pendiente: true, pagada: true })
      assert.deepEqual(accionesDe({ ...base, estado: 'pendiente' }), { pendiente: false, pagada: true })
      // en cuenta: se puede marcar pagada solo si ya tiene su cargo
      assert.equal(accionesDe({ ...base, metodo_pago: 'cuenta_corriente', estado: 'pendiente', enCuenta: false }).pagada, false)
      assert.equal(accionesDe({ ...base, metodo_pago: 'cuenta_corriente', estado: 'pendiente', enCuenta: true }).pagada, true)
      // de contado sin entregar, en curso, estimado, a convenir, grupo todo junto o anulada: nada
      for (const x of [{ estadoOp: 'pendiente' }, { enCurso: true }, { estimado: true }, { aConvenir: true }, { grupoTodoJunto: true }, { estadoOp: 'anulado' }]) {
        assert.deepEqual(accionesDe({ ...base, estado: 'pendiente', ...x }), { pendiente: false, pagada: false }, JSON.stringify(x))
      }
      assert.deepEqual(accionesDe(null), { pendiente: false, pagada: false })
    })

    it('venta en cuenta corriente: "marcar como pagada" registra el pago de esa operación y no toca las más viejas', async () => {
      const cli = await datos.crearCliente({ cuentaCorriente: true })
      const v1 = await venta(cli, '2026-09-10', 300000)
      const v2 = await venta(cli, '2026-10-10', 450000)
      assert.deepEqual(await estados(cli), { [v1]: 'pendiente', [v2]: 'pendiente' })
      const previa = await EstadoPago.vistaPreviaPagada(v2, { metodo_pago: 'transferencia' })
      assert.equal(previa.puede, true)
      assert.equal(previa.monto, 450000)
      assert.equal(previa.saldoDespues, -300000)
      await EstadoPago.marcarPagada(v2, { usuario: admin, metodo_pago: 'transferencia', fechaDia: '2026-10-15' })
      assert.deepEqual(await estados(cli), { [v1]: 'pendiente', [v2]: 'pagada' })
      assert.equal(await saldo(cli), -300000)
      const p = (await prueba.q(`SELECT monto, metodo_pago, created_at FROM movimientos_cuenta WHERE cliente_id = ? AND tipo = 'pago'`, [cli])).rows
      assert.equal(p.length, 1)
      assert.equal(Number(p[0].monto), 450000)
      assert.match(String(p[0].created_at), /^2026-10-15/)
      await assert.rejects(() => EstadoPago.marcarPagada(v2, { usuario: admin }), /ya está pagada/)
      // y se puede volver atrás: queda pendiente otra vez
      await EstadoPago.marcarPendiente(v2, { usuario: admin, motivo: 'Me equivoqué' })
      assert.deepEqual(await estados(cli), { [v1]: 'pendiente', [v2]: 'pendiente' })
      assert.equal(await saldo(cli), -750000)
    })

    it('Ventas: el listado y el detalle ofrecen los botones según el estado de cada venta', async () => {
      const cli = await datos.crearCliente({ cuentaCorriente: true })
      const vPaga = await venta(cli, '2026-10-05', 100000)
      await pagar(cli, 100000, [{ clave: 'op:' + vPaga, monto: 100000 }])
      const vDebe = await venta(cli, '2026-10-06', 90000)
      const lista = await llamarCtl(VentasController, 'index', { query: { id_cliente: String(cli), fechaDesde: '2026-10-01', fechaHasta: '2026-10-31', preset: 'rango' } })
      assert.equal(lista.vista, 'pages/ventas/index', JSON.stringify(lista.flashes))
      const html = await renderVista('pages/ventas/index', { ...lista.data, user })
      assert.match(html, new RegExp(`data-id="${vPaga}" data-accion="pendiente"`))
      assert.doesNotMatch(html, new RegExp(`data-id="${vPaga}" data-accion="pagada"`))
      assert.match(html, new RegExp(`data-id="${vDebe}" data-accion="pagada"`))
      assert.match(html, /id="modal-estado-pago"/)
      assert.doesNotMatch(await renderVista('pages/ventas/index', { ...lista.data, user: { rol: 'admin_ventas' } }), /btn-estado-pago/)

      const det = await llamarCtl(VentasController, 'detalle', { params: { id: vDebe } })
      assert.equal(det.vista, 'pages/ventas/detalle', JSON.stringify(det.flashes))
      const htmlDet = await renderVista('pages/ventas/detalle', { ...det.data, user })
      assert.match(htmlDet, new RegExp(`data-id="${vDebe}" data-accion="pagada"`))
      assert.match(htmlDet, /Pago: Pendiente/)
      assert.match(htmlDet, /id="modal-estado-pago"/)
    })

    it('Transacciones: las filas de cobros ofrecen los botones de su operación', async () => {
      const cli = await datos.crearCliente({ cuentaCorriente: true })
      const v1 = await venta(cli, '2026-10-10', 200000, 'efectivo')
      await prueba.q(`UPDATE op_encabezado SET estado = 'entregado' WHERE id = ?`, [v1])
      await TransaccionesModel.crear({ tipo: 'Venta Cantera', id_op_encabezado: v1, cliente_id: cli, monto: 200000, metodo_pago: 'efectivo', fecha: '2026-10-10 12:00:00' })
      const r = await llamarCtl(TransaccionesController, 'index', { query: { idCliente: String(cli), fechaDesde: '2026-10-01', fechaHasta: '2026-10-31', preset: 'rango' } })
      assert.equal(r.vista, 'pages/transacciones/index', JSON.stringify(r.flashes))
      const html = await renderVista('pages/transacciones/index', { ...r.data, user })
      assert.match(html, new RegExp(`data-id="${v1}" data-accion="pendiente"`))
      assert.match(html, /id="modal-estado-pago"/)
    })
  })

  describe('botones en Alquileres (contenedores y maquinaria)', () => {
    const AlquileresModel = require('../src/models/alquileres.model')
    const AlquileresMaquinariaModel = require('../src/models/alquileres_maquinaria.model')
    const AlquileresController = require('../src/controllers/alquileres.controller')
    const AlquileresMaquinariaController = require('../src/controllers/alquileres_maquinaria.controller')
    const { sumarDiasHabiles } = require('../src/utils/diasHabiles')

    function llamarCtl(controlador, accion, { params = {}, query = {} } = {}) {
      return new Promise((resolve, reject) => {
        const flashes = []
        const req = { body: {}, params, query, baseUrl: '', session: { user }, flash: (tipo, msg) => flashes.push({ tipo, msg }), get: () => null }
        const res = {
          redirect: (url) => resolve({ url, flashes }), render: (vista, data) => resolve({ vista, data, flashes }),
          json: (data) => resolve({ json: data, flashes }), status() { return this },
        }
        Promise.resolve(controlador[accion](req, res)).catch(reject)
      })
    }

    it('contenedor cobrado: el listado y el detalle ofrecen "Marcar pendiente"', async () => {
      AlquileresModel.ubicar = async () => null   // sin llamadas a Nominatim en las pruebas
      const cli = await datos.crearCliente({ cuentaCorriente: true })
      const [cont] = await datos.crearContenedores(1)
      const hace2 = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10)
      const a = await AlquileresModel.crearEnCurso({
        ...datos.datosComunes({ id_cliente: cli, id_administrativo: admin, metodo_pago: 'efectivo', fecha_inicio: hace2 }),
        id_contenedor: cont, plazo_alquiler: 20, precio_alquiler: 90000,
      })
      await TransaccionesModel.crear({ tipo: 'Alquiler', id_op_encabezado: a.id, cliente_id: cli, monto: 90000, metodo_pago: 'efectivo' })
      // Otro que vence pronto: se ve en las tarjetas de "Por finalizar"
      const [cont2] = await datos.crearContenedores(1)
      const b = await AlquileresModel.crearEnCurso({
        ...datos.datosComunes({ id_cliente: cli, id_administrativo: admin, metodo_pago: 'efectivo', fecha_inicio: hace2 }),
        id_contenedor: cont2, plazo_alquiler: 2, precio_alquiler: 50000,
      })
      await TransaccionesModel.crear({ tipo: 'Alquiler', id_op_encabezado: b.id, cliente_id: cli, monto: 50000, metodo_pago: 'efectivo' })
      const lista = await llamarCtl(AlquileresController, 'index')
      assert.equal(lista.vista, 'pages/alquileres/index', JSON.stringify(lista.flashes))
      const html = await renderVista('pages/alquileres/index', { ...lista.data, user })
      assert.match(html, new RegExp(`data-id="${a.id}" data-accion="pendiente"`))
      assert.match(html, new RegExp(`data-id="${b.id}" data-accion="pendiente"`))
      assert.match(html, /id="modal-estado-pago"/)
      const det = await llamarCtl(AlquileresController, 'detalle', { params: { id: a.id } })
      assert.equal(det.vista, 'pages/alquileres/detalle', JSON.stringify(det.flashes))
      const htmlDet = await renderVista('pages/alquileres/detalle', { ...det.data, user })
      assert.match(htmlDet, new RegExp(`data-id="${a.id}" data-accion="pendiente"`))
      assert.match(htmlDet, /Pago: Pagada/)
      assert.doesNotMatch(await renderVista('pages/alquileres/detalle', { ...det.data, user: { rol: 'admin_ventas' } }), /btn-estado-pago/)
    })

    it('maquinaria cobrada: el listado y el detalle ofrecen "Marcar pendiente"', async () => {
      const cli = await datos.crearCliente({ cuentaCorriente: true })
      const maq = (await prueba.q(`INSERT INTO maquinaria (nombre, tipo) VALUES ('Bobcat prueba', 'bobcat') RETURNING id`)).rows[0].id
      const futuro = sumarDiasHabiles(new Date().toISOString().slice(0, 10), 3)
      const a = await AlquileresMaquinariaModel.crear({
        id_cliente: cli, id_administrativo: admin, domicilio_entrega: 'San Lorenzo 501', domicilio_calle: 'San Lorenzo', domicilio_numero: '501',
        zona_entrega: '', plazo_alquiler: 3, precio_por_hora: 100, horas_pactadas: 8, precio_total: 800, id_maquinaria: maq,
        metodo_pago: 'efectivo', observaciones: 'PRUEBA', fecha_entrega_planificada: futuro,
      })
      const id = a.id || a
      await TransaccionesModel.crear({ tipo: 'Maquinaria', id_op_encabezado: id, cliente_id: cli, monto: 800, metodo_pago: 'efectivo' })
      const lista = await llamarCtl(AlquileresMaquinariaController, 'index')
      assert.equal(lista.vista, 'pages/alquileres/maquinaria_index', JSON.stringify(lista.flashes))
      const html = await renderVista('pages/alquileres/maquinaria_index', { ...lista.data, user })
      assert.match(html, new RegExp(`data-id="${id}" data-accion="pendiente"`))
      assert.match(html, /id="modal-estado-pago"/)
      const det = await llamarCtl(AlquileresMaquinariaController, 'detalle', { params: { id } })
      assert.equal(det.vista, 'pages/alquileres/maquinaria_detalle', JSON.stringify(det.flashes))
      const htmlDet = await renderVista('pages/alquileres/maquinaria_detalle', { ...det.data, user })
      assert.match(htmlDet, new RegExp(`data-id="${id}" data-accion="pendiente"`))
    })
  })
})
