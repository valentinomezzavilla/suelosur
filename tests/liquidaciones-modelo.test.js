'use strict'
// Liquidaciones contra la base, dentro de la transacción de prueba (ROLLBACK al final).
const prueba = require('./helpers/db')
const datos = require('./helpers/datos')
const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const VentasModel = require('../src/models/ventas.model')
const ClientesModel = require('../src/models/clientes.model')
const TransaccionesModel = require('../src/models/transacciones.model')
const LiquidacionesModel = require('../src/models/liquidaciones.model')
const { normalizarFiltros } = require('../src/utils/liquidaciones')

const HOY = '2026-10-06'
const filtros = (extra = {}) => normalizarFiltros({ desde: '2026-10-01', hasta: '2026-10-31', ...extra }, HOY)

describe('LiquidacionesModel.liquidacion', () => {
  let cliente, admin, producto, contado, cc, sinPrecio

  before(async () => {
    await prueba.abrir()
    admin = await datos.idAdministrativo()
    cliente = await datos.crearCliente({ cuentaCorriente: true })
    producto = (await prueba.q(`SELECT id FROM productos WHERE COALESCE(es_contenedor,0)=0 ORDER BY id LIMIT 1`)).rows[0].id
    const base = { id_cliente: cliente, id_administrativo: admin, tipo_op: 'M', modalidad: 'flete',
      fecha_entrega_planificada: '2026-10-05', domicilio: { calle: 'Colón', altura: '100' }, obra: null }

    // 1) Venta de contado cobrada: 1000 de producto + 200 de flete
    contado = (await VentasModel.crear({ ...base, metodo_pago: 'efectivo', precio_flete: 200, monto_total: 1200,
      detalles: [{ id_producto: producto, cantidad_pedida: 2, precio_unitario: 500 }] })).id
    await TransaccionesModel.crear({ tipo: 'Venta Viaje', id_op_encabezado: contado, cliente_id: cliente, cliente: 'PRUEBA',
      monto: 1200, descripcion: 'prueba', metodo_pago: 'efectivo', fecha: '2026-10-05' })

    // 2) Venta a cuenta corriente, total pactado editado (ajuste), con pago parcial
    cc = (await VentasModel.crear({ ...base, metodo_pago: 'cuenta_corriente', precio_flete: 0, monto_total: 900,
      obra: 'Obra Vélez 10', detalles: [{ id_producto: producto, cantidad_pedida: 1, precio_unitario: 1000 }] })).id
    await VentasModel.sincronizarCargoCC(cc)
    await ClientesModel.agregarMovimiento(cliente, { tipo: 'pago', descripcion: 'Pago prueba', monto: 400, metodo_pago: 'transferencia' })

    // 3) Alquiler de contenedor sin precio
    const [idCont] = await datos.crearContenedores(1)
    sinPrecio = (await prueba.q(`
      INSERT INTO op_encabezado (id_cliente, id_administrativo, tipo_op, nro_op, estado, fecha_entrega_planificada)
      VALUES (?, ?, 'C', 999999, 'pendiente', '2026-10-04') RETURNING id`, [cliente, admin])).rows[0].id
    await prueba.q(`INSERT INTO op_detalle_contenedor (id_orden_pedido, id_contenedor, domicilio_entrega, precio_alquiler)
      VALUES (?, ?, 'San Martín 55', NULL)`, [sinPrecio, idCont])
  })
  after(() => prueba.cerrar())

  const delCliente = async (extra) => {
    const r = await LiquidacionesModel.liquidacion(filtros({ clienteId: String(cliente), ...extra }))
    assert.equal(r.clientes.length, 1)
    return r.clientes[0]
  }
  const op = (c, id) => c.operaciones.find(o => String(o.id) === String(id))

  it('trae las tres operaciones con su estado de pago', async () => {
    const c = await delCliente()
    assert.deepEqual(c.operaciones.map(o => String(o.id)).sort(), [contado, cc, sinPrecio].map(String).sort())
    assert.deepEqual([op(c, contado).estado, op(c, cc).estado, op(c, sinPrecio).estado], ['pagada', 'parcial', 'a_convenir'])
    assert.equal(op(c, cc).pagado, 400)
    assert.equal(op(c, cc).resta, 500)
  })

  it('detalle: productos, flete y ajuste del total pactado', async () => {
    const c = await delCliente()
    assert.deepEqual(op(c, contado).renglones.map(r => [r.cantidad, r.importe]), [[2, 1000], [1, 200]])
    assert.equal(op(c, contado).renglones[1].descripcion, 'Flete')
    const ajuste = op(c, cc).renglones.find(r => r.descripcion === 'Ajuste de precio')
    assert.equal(ajuste.importe, -100)
    assert.equal(op(c, cc).total, 900)
    assert.equal(op(c, sinPrecio).renglones[0].descripcion.includes('Precio a convenir'), true)
  })

  it('resumen: sin contar el alquiler a convenir', async () => {
    const c = await delCliente()
    assert.deepEqual(c.resumen, { consumido: 2100, pagado: 1600, saldo: 500, cantidad: 3 })
  })

  it('pagos recibidos del período (sin obra): el abono de CC y el cobro de contado', async () => {
    // El abono se registra con la fecha real de hoy: el período llega lejos para incluirlo
    const c = await delCliente({ hasta: '2099-12-31' })
    assert.deepEqual(c.pagos.map(p => p.monto).sort((a, b) => a - b), [400, 1200])
  })

  it('con obra: solo esa obra y sin sección de pagos', async () => {
    const obras = await ClientesModel.obras(cliente)
    const velez = obras.find(o => o.nombre === 'Vélez 10')
    const c = await delCliente({ obra: velez.clave })
    assert.deepEqual(c.operaciones.map(o => String(o.id)), [String(cc)])
    assert.equal(c.pagos, null)
  })

  it('filtra por tipo y por estado de pago', async () => {
    assert.deepEqual((await delCliente({ tipos: 'contenedor' })).operaciones.map(o => String(o.id)), [String(sinPrecio)])
    assert.deepEqual((await delCliente({ estadoPago: 'pendientes' })).operaciones.map(o => String(o.id)), [String(cc)])
    assert.deepEqual((await delCliente({ estadoPago: 'pagadas' })).operaciones.map(o => String(o.id)), [String(contado)])
  })

  it('fuera del período: sin operaciones y totales en cero', async () => {
    const r = await LiquidacionesModel.liquidacion(normalizarFiltros({ clienteId: String(cliente), desde: '2020-01-01', hasta: '2020-01-31' }, HOY))
    assert.deepEqual(r.clientes[0].operaciones, [])
    assert.deepEqual(r.clientes[0].resumen, { consumido: 0, pagado: 0, saldo: 0, cantidad: 0 })
  })

  it('sin cliente: incluye al cliente de prueba entre todos, sin pagos', async () => {
    const r = await LiquidacionesModel.liquidacion(filtros())
    const c = r.clientes.find(x => String(x.cliente.id) === String(cliente))
    assert.ok(c)
    assert.equal(c.pagos, null)
    assert.ok(r.resumen.consumido >= 2100)
  })

  it('cliente inexistente', async () => {
    const r = await LiquidacionesModel.liquidacion(filtros({ clienteId: '999999999' }))
    assert.equal(r.clienteInexistente, true)
    assert.deepEqual(r.clientes, [])
  })

  it('pagadoPorOperacion devuelve total y pagado del cargo', async () => {
    const r = await ClientesModel.pagadoPorOperacion([cc, contado])
    assert.deepEqual(r[cc], { total: 900, pagado: 400 })
    assert.equal(r[contado], undefined)
    assert.deepEqual(await ClientesModel.saldadaPorOperacion([cc]), { [cc]: false })
  })
})
