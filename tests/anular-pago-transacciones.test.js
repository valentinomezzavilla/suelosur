'use strict'
// Anular un pago de cliente desde Transacciones: vista previa (qué operaciones vuelven a pendiente),
// anulación auditada y las rutas / vista que la usan. Corre dentro de la transacción de prueba
// (ROLLBACK al final).
const prueba = require('./helpers/db')
const datos = require('./helpers/datos')
const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const VentasModel = require('../src/models/ventas.model')
const ClientesModel = require('../src/models/clientes.model')

let admin, producto
before(async () => {
  await prueba.abrir()
  admin = await datos.idAdministrativo()
  producto = (await prueba.q(`SELECT id FROM productos WHERE COALESCE(es_contenedor,0)=0 ORDER BY id LIMIT 1`)).rows[0].id
})
after(() => prueba.cerrar())

// Venta a cuenta corriente con su cargo en la cuenta del cliente
const venta = async (cliente, fecha, neto, { remito = null, obra = null } = {}) => {
  const id = (await VentasModel.crear({
    id_cliente: cliente, id_administrativo: admin, tipo_op: 'M', modalidad: 'deposito', metodo_pago: 'cuenta_corriente',
    fecha_emision: fecha, monto_total: neto, nro_remito: remito, obra,
    detalles: [{ id_producto: producto, cantidad_pedida: 1, precio_unitario: neto }],
  })).id
  await VentasModel.sincronizarCargoCC(id)
  return id
}
// Pago del cliente. `aOps`: [{ id, monto }] = las obras elegidas al registrarlo ([] = a lo más viejo)
const pagar = async (cliente, monto, fecha, aOps = []) => {
  const elegidas = await ClientesModel.validarImputaciones(cliente, aOps.map(o => ({ clave: `op:${o.id}`, monto: o.monto })), monto)
  const id = await ClientesModel.agregarMovimiento(cliente, { tipo: 'pago', descripcion: 'Pago', monto, metodo_pago: 'transferencia', fecha })
  await ClientesModel.guardarImputaciones(id, elegidas)
  return id
}
const saldoDe = async (cliente) => Number((await prueba.q(`SELECT saldo FROM clientes WHERE id = ?`, [cliente])).rows[0].saldo)
const MOTIVO = 'Se cargó al cliente equivocado'

describe('vista previa y anulación de un pago de cliente (modelo)', () => {
  it('un pago por remito sobre 4 obras: la vista previa lista las 4 con su importe', async () => {
    const cli = await datos.crearCliente({ cuentaCorriente: true })
    const importes = [40000, 55000, 70000, 85000]
    const ops = []
    for (const [i, neto] of importes.entries()) ops.push(await venta(cli, `2026-10-1${i}`, neto, { remito: 8100, obra: `Obra ${i + 1}` }))
    const total = importes.reduce((s, n) => s + n, 0)
    const pago = await pagar(cli, total, '2026-11-02 10:00:00', ops.map((id, i) => ({ id, monto: importes[i] })))

    const v = await ClientesModel.vistaPreviaAnularPago(pago)
    assert.equal(v.puede, true)
    assert.deepEqual(v.bloqueos, [])
    assert.equal(v.idPago, pago)
    assert.equal(v.monto, total)
    assert.equal(v.operaciones.length, 4)
    ops.forEach((id, i) => {
      const o = v.operaciones.find(x => String(x.id) === String(id))
      assert.ok(o, `falta la operación ${id}`)
      assert.equal(o.quitado, importes[i])
      assert.equal(o.remito, 8100)
      assert.equal(o.obra, `Obra ${i + 1}`)
      assert.match(o.etiqueta, /^OP-\d{4}$/)
    })
    assert.equal(v.operaciones.reduce((s, o) => s + o.quitado, 0), total)
    assert.equal(v.aFavorQuitado, 0)
    assert.equal(v.saldoDespues, v.saldoAntes - total)
  })

  it('anularPagoAuditado deja las 4 obras pendientes, mueve el saldo lo previsto y audita', async () => {
    const cli = await datos.crearCliente({ cuentaCorriente: true })
    const ops = [await venta(cli, '2026-10-10', 30000), await venta(cli, '2026-10-11', 40000), await venta(cli, '2026-10-12', 50000), await venta(cli, '2026-10-13', 60000)]
    const montos = [30000, 40000, 50000, 60000]
    const pago = await pagar(cli, 180000, '2026-11-02 10:00:00', ops.map((id, i) => ({ id, monto: montos[i] })))
    const antes = await ClientesModel.pagadoPorOperacion(ops)
    ops.forEach(id => assert.equal(antes[String(id)].pagado, antes[String(id)].total))
    const v = await ClientesModel.vistaPreviaAnularPago(pago)

    const m = await ClientesModel.anularPagoAuditado(pago, cli, { usuario: admin, motivo: MOTIVO })
    assert.equal(String(m.id), String(pago))

    const despues = await ClientesModel.pagadoPorOperacion(ops)
    ops.forEach(id => assert.equal(despues[String(id)].pagado, 0))
    assert.equal(await saldoDe(cli), v.saldoDespues)
    const mov = (await prueba.q(`SELECT anulado, anulado_motivo, anulado_por FROM movimientos_cuenta WHERE id = ?`, [pago])).rows[0]
    assert.equal(Number(mov.anulado), 1)
    assert.equal(mov.anulado_motivo, MOTIVO)
    assert.equal(String(mov.anulado_por), String(admin))
    const auditoria = (await prueba.q(
      `SELECT detalle FROM auditoria WHERE entidad_tipo = 'movimiento_cuenta' AND entidad_id = ? AND accion = 'anular_pago'`, [pago])).rows
    assert.equal(auditoria.length, 1)
    assert.match(JSON.stringify(auditoria[0].detalle), new RegExp(MOTIVO))
  })

  it('un pago que no eligió obras y cubría lo más viejo: la vista previa muestra la operación que queda pendiente', async () => {
    const cli = await datos.crearCliente({ cuentaCorriente: true })
    const A = await venta(cli, '2026-10-10', 100000)
    const B = await venta(cli, '2026-10-15', 100000)
    const P1 = await pagar(cli, 100000, '2026-11-01 10:00:00', [{ id: A, monto: 100000 }])
    await pagar(cli, 100000, '2026-11-02 10:00:00')            // sin elegir: cae en B (A ya está cubierta por P1)
    const v = await ClientesModel.vistaPreviaAnularPago(P1)
    assert.equal(v.operaciones.length, 1)
    assert.equal(String(v.operaciones[0].id), String(B))
    assert.equal(v.operaciones[0].quitado, 100000)
  })

  it('un pago mayor que las deudas informa el saldo a favor que se quita', async () => {
    const cli = await datos.crearCliente({ cuentaCorriente: true })
    const A = await venta(cli, '2026-10-10', 100000)
    const pago = await pagar(cli, 150000, '2026-11-01 10:00:00')
    const v = await ClientesModel.vistaPreviaAnularPago(pago)
    assert.equal(v.operaciones.length, 1)
    assert.equal(String(v.operaciones[0].id), String(A))
    assert.equal(v.operaciones[0].quitado, 100000)
    assert.equal(v.aFavorQuitado, 50000)
  })

  it('bloquea un pago con cheque, uno ya anulado, un movimiento que no es pago y uno que no existe', async () => {
    const cli = await datos.crearCliente({ cuentaCorriente: true })
    const A = await venta(cli, '2026-10-10', 100000)
    const conCheque = await pagar(cli, 20000, '2026-11-01 10:00:00')
    await prueba.q(`INSERT INTO cheques (tipo_cartera, monto, id_cliente, id_mov_cuenta) VALUES ('recibido', 20000, ?, ?)`, [cli, conCheque])
    const vCheque = await ClientesModel.vistaPreviaAnularPago(conCheque)
    assert.equal(vCheque.puede, false)
    assert.match(vCheque.bloqueos[0], /cheque.*Cheques/)

    const anulado = await pagar(cli, 30000, '2026-11-02 10:00:00')
    await ClientesModel.anularPago(anulado, cli, { usuario: admin, motivo: 'x' })
    const vAnulado = await ClientesModel.vistaPreviaAnularPago(anulado)
    assert.equal(vAnulado.puede, false)
    assert.deepEqual(vAnulado.bloqueos, ['Ese pago ya estaba anulado.'])

    const cargo = (await prueba.q(`SELECT id FROM movimientos_cuenta WHERE cliente_id = ? AND tipo = 'deuda' AND id_op_encabezado = ?`, [cli, A])).rows[0].id
    const vCargo = await ClientesModel.vistaPreviaAnularPago(cargo)
    assert.equal(vCargo.puede, false)
    assert.deepEqual(vCargo.bloqueos, ['Solo se pueden anular pagos.'])

    const vNada = await ClientesModel.vistaPreviaAnularPago(999999999)
    assert.equal(vNada.puede, false)
    assert.deepEqual(vNada.bloqueos, ['El pago no existe.'])
  })
})
