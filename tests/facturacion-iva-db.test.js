'use strict'
// Operaciones para facturar: al neto se le suma el 21% y el cliente debe el total con IVA.
// Corre dentro de la transacción de prueba (ROLLBACK al final: nada queda guardado).
const prueba = require('./helpers/db')
const datos = require('./helpers/datos')
const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const VentasModel = require('../src/models/ventas.model')
const TransaccionesModel = require('../src/models/transacciones.model')
const AlquileresModel = require('../src/models/alquileres.model')
const LiquidacionesModel = require('../src/models/liquidaciones.model')
const FacturacionModel = require('../src/models/facturacion.model')
const ReportesModel = require('../src/models/reportes.model')
const RemitosModel = require('../src/models/remitos.model')
const { normalizarFiltros } = require('../src/utils/liquidaciones')
const { hoyISO } = require('../src/utils/fecha')

describe('facturación con IVA sumado al neto', () => {
  let admin, producto

  before(async () => {
    await prueba.abrir()
    admin = await datos.idAdministrativo()
    producto = (await prueba.q(`SELECT id FROM productos WHERE COALESCE(es_contenedor,0)=0 ORDER BY id LIMIT 1`)).rows[0].id
  })
  after(() => prueba.cerrar())

  const venta = async ({ id_cliente, metodo_pago, neto = 150000 }) => (await VentasModel.crear({
    id_cliente, id_administrativo: admin, tipo_op: 'M', modalidad: 'flete', metodo_pago,
    fecha_entrega_planificada: '2026-10-05', domicilio: { calle: 'Colón', altura: '100' }, obra: null,
    precio_flete: 20000, monto_total: neto, detalles: [{ id_producto: producto, cantidad_pedida: 10, precio_unitario: 13000 }],
  })).id
  const cargos = async (id) => (await prueba.q(`SELECT tipo, monto FROM movimientos_cuenta WHERE id_op_encabezado = ? ORDER BY id`, [id])).rows
  const saldo = async (id) => Number((await prueba.q(`SELECT saldo FROM clientes WHERE id = ?`, [id])).rows[0].saldo)
  const txs = async (id) => (await prueba.q(`SELECT monto FROM transacciones WHERE id_op_encabezado = ? ORDER BY id`, [id])).rows.map(r => Number(r.monto))
  const liquidacionDe = async (id_cliente, id) => {
    const r = await LiquidacionesModel.liquidacion(normalizarFiltros({ clienteId: String(id_cliente), desde: '2026-01-01', hasta: '2026-12-31' }, hoyISO()))
    return r.clientes[0].operaciones.find(o => String(o.id) === String(id))
  }

  it('venta a cuenta corriente para facturar: el cargo es neto + IVA ($150.000 → $181.500)', async () => {
    const cli = await datos.crearCliente({ cuentaCorriente: true })
    const id = await venta({ id_cliente: cli, metodo_pago: 'cuenta_corriente' })
    const alic = await FacturacionModel.marcarAlCrear(id, '1', 150000)
    assert.equal(alic, 21)
    await VentasModel.sincronizarCargoCC(id)
    assert.deepEqual((await cargos(id)).map(c => Number(c.monto)), [-181500])
    assert.equal(await saldo(cli), -181500)

    const op = await VentasModel.obtener(id)
    assert.equal(op.neto, 150000)
    assert.equal(op.iva, 31500)
    assert.equal(op.total, 181500)

    // Liquidación: renglón de IVA y total con IVA
    const l = await liquidacionDe(cli, id)
    assert.equal(l.total, 181500)
    assert.equal(l.resta, 181500)
    assert.deepEqual(l.renglones.filter(r => r.esIva).map(r => [r.descripcion, r.importe]), [['IVA 21%', 31500]])

    // Facturación: neto, IVA y total
    const f = await FacturacionModel.estadoOp(id)
    assert.deepEqual([f.neto, f.iva, f.monto, f.con_iva], [150000, 31500, 181500, true])

    // Remito y libro de ventas: suman el IVA
    const rem = await RemitosModel.obtener(id)
    assert.equal(rem.total, 181500)
    const libro = await ReportesModel.libroVentas({ opIds: [id] })
    assert.equal(libro.total, 181500)

    // Editar el total (neto): el cargo acompaña con el IVA
    await prueba.q(`UPDATE op_encabezado SET monto_total = 100000 WHERE id = ?`, [id])
    await VentasModel.sincronizarCargoCC(id)
    assert.deepEqual((await cargos(id)).map(c => Number(c.monto)), [-121000])
  })

  it('venta sin tildar: no se suma nada', async () => {
    const cli = await datos.crearCliente({ cuentaCorriente: true })
    const id = await venta({ id_cliente: cli, metodo_pago: 'cuenta_corriente' })
    assert.equal(await FacturacionModel.marcarAlCrear(id, undefined, 150000), 0)
    await VentasModel.sincronizarCargoCC(id)
    assert.deepEqual((await cargos(id)).map(c => Number(c.monto)), [-150000])
  })

  it('marcar después y quitar: la deuda en cuenta corriente sube y baja el IVA', async () => {
    const cli = await datos.crearCliente({ cuentaCorriente: true })
    const id = await venta({ id_cliente: cli, metodo_pago: 'cuenta_corriente', neto: 1000 })
    await VentasModel.sincronizarCargoCC(id)
    await FacturacionModel.marcar(id)
    assert.deepEqual((await cargos(id)).map(c => Number(c.monto)), [-1210])
    assert.equal(await saldo(cli), -1210)
    await FacturacionModel.quitar(id)
    assert.deepEqual((await cargos(id)).map(c => Number(c.monto)), [-1000])
    assert.equal(await saldo(cli), -1000)
    const f = await FacturacionModel.estadoOp(id)
    assert.equal(f.para_facturar, false)
    assert.equal(f.con_iva, false)
  })

  it('venta de contado ya cobrada y marcada después: el IVA queda como saldo pendiente', async () => {
    const cli = await datos.crearCliente()
    const id = await venta({ id_cliente: cli, metodo_pago: 'efectivo', neto: 1000 })
    await TransaccionesModel.crear({ tipo: 'Venta Viaje', id_op_encabezado: id, cliente_id: cli, monto: 1000, metodo_pago: 'efectivo', fecha: '2026-10-05' })
    await FacturacionModel.marcar(id)
    const l = await liquidacionDe(cli, id)
    assert.equal(l.total, 1210)
    assert.equal(l.estado, 'parcial')
    assert.equal(l.resta, 210)
    assert.deepEqual(await txs(id), [1000])
  })

  it('alquiler para facturar: al asignar el precio ya retirado se cobra neto + IVA', async () => {
    const cli = await datos.crearCliente({ cuentaCorriente: true })
    const [cont] = await datos.crearContenedores(1)
    const a = await AlquileresModel.crearEnCurso({
      ...datos.datosComunes({ id_cliente: cli, id_administrativo: admin, metodo_pago: null, fecha_inicio: '2026-10-01' }),
      id_contenedor: cont, plazo_alquiler: 4,
    })
    await FacturacionModel.marcarAlCrear(a.id, '1', null)
    assert.equal((await FacturacionModel.estadoOp(a.id)).sin_precio, true)
    await AlquileresModel.devolverAPlanta(a.id)
    await AlquileresModel.asignarPrecio(a.id, { precio: 100000, metodo_pago: 'cuenta_corriente' })
    assert.deepEqual(await txs(a.id), [121000])
    assert.deepEqual((await cargos(a.id)).map(c => Number(c.monto)), [-121000])
    const f = await FacturacionModel.estadoOp(a.id)
    assert.deepEqual([f.neto, f.iva, f.monto, f.sin_precio], [100000, 21000, 121000, false])

    // Quitar: la cuenta corriente recibe el ajuste y la transacción vuelve al neto
    await FacturacionModel.quitar(a.id)
    assert.deepEqual(await txs(a.id), [100000])
    assert.deepEqual((await cargos(a.id)).map(c => [c.tipo, Number(c.monto)]), [['deuda', -121000], ['ajuste', 21000]])
    assert.equal(await saldo(cli), -100000)

    // Volver a marcar: se suma de nuevo
    await FacturacionModel.marcar(a.id)
    assert.deepEqual(await txs(a.id), [121000])
    assert.equal(await saldo(cli), -121000)
  })

  it('operaciones viejas (marcadas sin IVA sumado) siguen como antes: el monto es el final', async () => {
    const cli = await datos.crearCliente({ cuentaCorriente: true })
    const id = await venta({ id_cliente: cli, metodo_pago: 'cuenta_corriente', neto: 1210 })
    await prueba.q(`UPDATE op_encabezado SET para_facturar = 1, monto_facturar = 1210 WHERE id = ?`, [id])
    await VentasModel.sincronizarCargoCC(id)
    assert.deepEqual((await cargos(id)).map(c => Number(c.monto)), [-1210])
    const f = await FacturacionModel.estadoOp(id)
    assert.deepEqual([f.con_iva, f.monto, f.neto, f.iva], [false, 1210, 1000, 210])
  })

  it('el detalle para el PDF trae las operaciones con sus renglones', async () => {
    const cli = await datos.crearCliente()
    const id = await venta({ id_cliente: cli, metodo_pago: 'efectivo' })
    await FacturacionModel.marcarAlCrear(id, '1', 150000)
    const [f] = await FacturacionModel.porIds([id])
    assert.equal(f.monto, 181500)
    const armadas = await LiquidacionesModel.operacionesPorIds([id])
    assert.equal(armadas[id].neto, 150000)
    assert.equal(armadas[id].total, 181500)
  })
})
