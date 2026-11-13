'use strict'
// Marcar pendiente un REMITO: se dejan pendientes todas sus operaciones juntas (mismo cliente y
// mismo N° de remito) y ninguna otra cambia de estado ni de saldo. Cuenta corriente.
// Corre dentro de la transacción de prueba (ROLLBACK al final).
const prueba = require('./helpers/db')
const datos = require('./helpers/datos')
const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const EstadoPago = require('../src/models/estadoPago.model')
const ClientesModel = require('../src/models/clientes.model')
const VentasModel = require('../src/models/ventas.model')
const LiquidacionesModel = require('../src/models/liquidaciones.model')
const { normalizarFiltros } = require('../src/utils/liquidaciones')

const mov = (id, monto, extra = {}) => ({ id, monto, tipo: monto < 0 ? 'deuda' : 'pago', id_op_encabezado: null, ...extra })
const resumirCambios = (r) => r.cambios.map(c => [c.idPago, c.montoNuevo, c.tocaMonto, c.imputaciones.map(i => [i.idOp, i.monto])])

describe('calcularReversion con varias operaciones (lógica pura)', () => {
  it('un pago que cubría las tres: al dejar dos pendientes queda por la tercera, escrito a ella', () => {
    const movs = [mov(1, -500, { id_op_encabezado: 10 }), mov(2, -500, { id_op_encabezado: 20 }), mov(3, -500, { id_op_encabezado: 30 }), mov(4, 1500)]
    const r = EstadoPago.calcularReversion(movs, [], [10, 20])
    assert.equal(r.pagadoAntes, 1000)
    assert.deepEqual(resumirCambios(r), [[4, 500, true, [[30, 500]]]])
  })

  it('un solo id y un array de un id dan lo mismo (compatibilidad)', () => {
    const movs = [mov(1, -500, { id_op_encabezado: 10 }), mov(2, -500, { id_op_encabezado: 20 }), mov(3, 700)]
    assert.deepEqual(EstadoPago.calcularReversion(movs, [], 10), EstadoPago.calcularReversion(movs, [], [10]))
  })

  it('otro pago a lo más viejo no se corre a las operaciones que quedan pendientes', () => {
    // Pago 4 cubría la 30; al quedar pendientes la 10 y la 20 (más viejas) el pago 4 las cubriría a ellas:
    // hay que dejarlo escrito para la 30
    const movs = [mov(1, -500, { id_op_encabezado: 10 }), mov(2, -500, { id_op_encabezado: 20 }), mov(3, 1000), mov(5, -500, { id_op_encabezado: 30 }), mov(4, 500)]
    const r = EstadoPago.calcularReversion(movs, [], [10, 20])
    assert.deepEqual(resumirCambios(r), [[3, 0, true, []], [4, 500, false, [[30, 500]]]])
  })

  it('una operación ajena al conjunto no cambia aunque sea de otro remito', () => {
    const movs = [mov(1, -500, { id_op_encabezado: 10 }), mov(2, -500, { id_op_encabezado: 20 }), mov(3, 500), mov(4, 500)]
    // Pagos 3 y 4 cubren la 10 y la 20; quedan pendientes solo la 10 → la 20 sigue pagada
    const r = EstadoPago.calcularReversion(movs, [], [10])
    const final = r.cambios.map(c => c.montoNuevo).reduce((s, n) => s + n, 0)
    assert.equal(final, 500)
    assert.deepEqual(r.cambios.flatMap(c => c.imputaciones.map(i => i.idOp)), [20])
  })

  it('sin pagos aplicados a ninguna de las operaciones no hay nada que cambiar', () => {
    const r = EstadoPago.calcularReversion([mov(1, -600, { id_op_encabezado: 10 }), mov(2, -600, { id_op_encabezado: 20 })], [], [10, 20])
    assert.deepEqual(r.cambios, [])
  })
})

describe('marcar pendiente un remito con dos operaciones, cuenta corriente (en la base)', () => {
  let admin, producto
  before(async () => {
    await prueba.abrir()
    admin = await datos.idAdministrativo()
    producto = (await prueba.q(`SELECT id FROM productos WHERE COALESCE(es_contenedor,0)=0 ORDER BY id LIMIT 1`)).rows[0].id
  })
  after(() => prueba.cerrar())

  const venta = async (cliente, fecha, neto, remito = null) => {
    const id = (await VentasModel.crear({
      id_cliente: cliente, id_administrativo: admin, tipo_op: 'M', modalidad: 'deposito', metodo_pago: 'cuenta_corriente',
      fecha_emision: fecha, monto_total: neto, nro_remito: remito, detalles: [{ id_producto: producto, cantidad_pedida: 1, precio_unitario: neto }],
    })).id
    await VentasModel.sincronizarCargoCC(id)
    return id
  }
  const pagar = async (cliente, monto) => {
    const id = await ClientesModel.agregarMovimiento(cliente, { tipo: 'pago', descripcion: 'Pago', monto, metodo_pago: 'echeq', fecha: '2026-11-11 12:00:00' })
    await ClientesModel.guardarImputaciones(id, [])
    return id
  }
  const foto = async (cliente) => {
    const l = (await LiquidacionesModel.liquidacion(normalizarFiltros({ clienteId: String(cliente), desde: '2000-01-01', hasta: '2099-12-31' }, '2026-11-13'))).clientes[0]
    const saldo = Number((await prueba.q(`SELECT saldo FROM clientes WHERE id = ?`, [cliente])).rows[0].saldo)
    return { ops: Object.fromEntries(l.operaciones.map(o => [String(o.id), { estado: o.estado, pagado: o.pagado, resta: o.resta }])), saldo }
  }

  it('las dos operaciones del remito quedan pendientes y las demás (del cliente y de otro cliente) no cambian', async () => {
    const cli = await datos.crearCliente({ cuentaCorriente: true })
    const A0 = await venta(cli, '2026-10-10', 100000)             // más vieja, de otro remito
    const R1 = await venta(cli, '2026-10-14', 200000, 8001)       // remito 8001
    const R2 = await venta(cli, '2026-10-15', 150000, 8001)       // remito 8001
    const Z = await venta(cli, '2026-10-20', 100000)              // posterior, sin pagar
    await pagar(cli, 250000)                                      // 100.000 de A0 + 150.000 de R1
    await pagar(cli, 200000)                                      // 50.000 de R1 + 150.000 de R2
    // Otro cliente con el MISMO número de remito: es ajeno
    const otro = await datos.crearCliente({ cuentaCorriente: true })
    const S = await venta(otro, '2026-10-12', 50000, 8001)
    await pagar(otro, 50000)

    const antes = await foto(cli), antesOtro = await foto(otro)
    assert.deepEqual([antes.ops[A0].estado, antes.ops[R1].estado, antes.ops[R2].estado, antes.ops[Z].estado], ['pagada', 'pagada', 'pagada', 'pendiente'])

    // Vista previa: pide dejar pendiente UNA, pero el remito tiene dos
    const previa = await EstadoPago.vistaPreviaPendiente(R1)
    assert.equal(previa.puede, true)
    assert.equal(previa.opsDelRemito, 2)
    assert.deepEqual(previa.operaciones.map(o => [o.id, o.quitado]).sort(), [[R1, 200000], [R2, 150000]].sort())
    assert.equal(previa.resumen.quitado, 350000)
    assert.equal(previa.resumen.otrasOperaciones, 2)             // A0 y Z (la de otro cliente no cuenta)
    assert.equal(previa.saldoAntes - previa.saldoDespues, 350000)
    // Lo que se quita a cada operación suma lo que se quita en total
    assert.equal(previa.operaciones.reduce((s, o) => s + o.quitado, 0), previa.resumen.quitado)

    await EstadoPago.marcarPendiente(R1, { usuario: admin, motivo: 'El cheque rebotó' })

    const despues = await foto(cli)
    // Las del remito, pendientes
    assert.deepEqual([despues.ops[R1].estado, despues.ops[R2].estado], ['pendiente', 'pendiente'])
    assert.deepEqual([despues.ops[R1].resta, despues.ops[R2].resta], [200000, 150000])
    // Las demás, idénticas (estado, pagado y resta)
    assert.deepEqual(despues.ops[A0], antes.ops[A0])
    assert.deepEqual(despues.ops[Z], antes.ops[Z])
    assert.deepEqual(await foto(otro), antesOtro)
    assert.equal(despues.saldo, antes.saldo - 350000)

    // Quedó registrado en cada operación del remito
    const aud = (await prueba.q(`SELECT entidad_id FROM auditoria WHERE entidad_tipo = 'operacion' AND accion = 'marcar_pendiente' ORDER BY entidad_id`)).rows.map(r => String(r.entidad_id))
    assert.deepEqual(aud, [String(R1), String(R2)].sort())
    // Ya no hay nada más que dejar pendiente: el remito completo está pendiente
    await assert.rejects(() => EstadoPago.marcarPendiente(R2, { usuario: admin, motivo: 'otra vez' }), /ya están pendientes/)
  })
})
