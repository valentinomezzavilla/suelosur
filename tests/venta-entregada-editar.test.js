'use strict'
// Editar una venta (viaje o cantera) YA ENTREGADA:
//  - el stock real se corrige por la diferencia de cantidad (el pendiente no se toca);
//  - la transacción de cobro, el egreso a tercero y la cuenta corriente acompañan al monto;
//  - una venta facturada no deja cambiar el monto; una anulada no se edita.
// Corre dentro de la transacción de prueba (ROLLBACK al final: nada queda guardado).
const prueba = require('./helpers/db')
const datos = require('./helpers/datos')
const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const VentasModel = require('../src/models/ventas.model')
const VentasController = require('../src/controllers/ventas.controller')
const TransaccionesModel = require('../src/models/transacciones.model')
const ClientesModel = require('../src/models/clientes.model')

function llamar(Controller, accion, { body = {}, params = {}, query = {}, user }) {
  return new Promise((resolve, reject) => {
    const flashes = []
    const req = { body, params, query, session: { user }, flash: (tipo, msg) => flashes.push({ tipo, msg }), get: () => null }
    const res = { locals: {}, redirect: (url) => resolve({ url, flashes }), render: (vista, data) => resolve({ vista, data, flashes }), status: () => res }
    Promise.resolve(Controller[accion](req, res)).catch(reject)
  })
}

describe('modelo: editar una venta entregada', () => {
  let admin, user, cliente

  before(async () => {
    await prueba.abrir()
    admin = await datos.idAdministrativo()
    user = { id: admin, rol: 'dueno' }
    cliente = await datos.crearCliente()
  })
  after(() => prueba.cerrar())

  // ── fixtures ────────────────────────────────────────────────
  const producto = async ({ stock = 100, dependeStock = 1, precioCantera = 1000, nombre = 'Arena prueba entregada', esContenedor = 0 } = {}) => {
    const id = (await prueba.q(`INSERT INTO productos (nombre, unidad_medida, precio_cantera, precio_viaje, activo, depende_stock, es_contenedor)
      VALUES (?, 'm³', ?, 1200, 1, ?, ?) RETURNING id`, [nombre, precioCantera, dependeStock, esContenedor])).rows[0].id
    await prueba.q(`INSERT INTO stock (id_producto, cantidad_actual, cant_pendiente_entregar, stock_minimo) VALUES (?, ?, 0, 0)
      ON CONFLICT (id_producto) DO UPDATE SET cantidad_actual = EXCLUDED.cantidad_actual, cant_pendiente_entregar = 0`, [id, stock])
    return id
  }
  const crearViaje = async ({ prod, cantidad = 2, precio = 1000, metodo = 'efectivo', cli = cliente, tercero = null, iva = 0 }) => {
    const id = (await VentasModel.crear({
      id_cliente: cli, id_administrativo: admin, tipo_op: 'M', modalidad: 'flete', metodo_pago: metodo,
      fecha_emision: '2026-11-10', fecha_entrega_planificada: '2026-11-20', domicilio: { calle: 'Colón', altura: '100' }, obra: null,
      precio_flete: 0, monto_total: cantidad * precio, detalles: [{ id_producto: prod, cantidad_pedida: cantidad, precio_unitario: precio }],
    })).id
    // Para facturar: el IVA se suma al neto antes de entregar (la transacción nace con el IVA)
    if (iva) await prueba.q(`UPDATE op_encabezado SET para_facturar = 1, iva_alicuota = ? WHERE id = ?`, [iva, id])
    // Transferencia a tercero: queda en la operación y la entrega genera su egreso
    if (tercero) await require('../src/services/tercero.service').guardarEnOp(id, tercero)
    return id
  }
  const viajeEntregado = async (opts) => {
    const id = await crearViaje(opts)
    const r = await llamar(VentasController, 'entregar', { user, params: { id }, body: {} })
    assert.ok(!r.flashes.some(f => f.tipo === 'error'), JSON.stringify(r.flashes))
    return id
  }
  const canteraEntregada = async ({ items, metodo = 'efectivo', cli = cliente }) => {
    const r = await llamar(VentasController, 'finalizarCantera', { user, body: {
      clienteId: String(cli), clienteNombre: 'PRUEBA', metodoPago: metodo, items: JSON.stringify(items),
    } })
    assert.ok(!r.flashes.some(f => f.tipo === 'error'), JSON.stringify(r.flashes))
    return (await prueba.q(`SELECT id FROM op_encabezado WHERE id_cliente = ? ORDER BY id DESC LIMIT 1`, [cli])).rows[0].id
  }
  const stockDe = async (prod) => {
    const s = (await prueba.q(`SELECT cantidad_actual, cant_pendiente_entregar FROM stock WHERE id_producto = ?`, [prod])).rows[0]
    return { actual: Number(s.cantidad_actual), pendiente: Number(s.cant_pendiente_entregar) }
  }
  const fila = async (id) => (await prueba.q(`SELECT * FROM op_encabezado WHERE id = ?`, [id])).rows[0]
  const lineasDe = async (id) => (await prueba.q(`SELECT * FROM op_detalle_material WHERE id_orden_pedido = ? ORDER BY id`, [id])).rows

  const base = { calle: 'Colón', numero: '100', fecha: '2026-11-20', metodoPago: 'efectivo' }

  // ── stock y líneas ──────────────────────────────────────────
  it('viaje entregado: subir la cantidad descuenta del stock actual y no toca el pendiente', async () => {
    const prod = await producto()
    const id = await viajeEntregado({ prod, cantidad: 2, precio: 1000 })
    assert.deepEqual(await stockDe(prod), { actual: 98, pendiente: 0 })
    const r = await VentasModel.actualizarVenta(id, { ...base, cantidad: 5, precioProducto: 1000 })
    assert.equal(r.entregada, true)
    assert.deepEqual(await stockDe(prod), { actual: 95, pendiente: 0 })
    assert.equal(Number((await fila(id)).monto_total), 5000)
  })

  it('viaje entregado: bajar la cantidad devuelve stock', async () => {
    const prod = await producto()
    const id = await viajeEntregado({ prod, cantidad: 2, precio: 1000 })
    await VentasModel.actualizarVenta(id, { ...base, cantidad: 1, precioProducto: 1000 })
    assert.deepEqual(await stockDe(prod), { actual: 99, pendiente: 0 })
  })

  it('cantera con dos productos: cada línea corrige su stock y el total es la suma', async () => {
    const arena = await producto()
    const piedra = await producto({ nombre: 'Piedra prueba entregada', precioCantera: 3000 })
    const id = await canteraEntregada({ items: [{ id: arena, cantidad: 2 }, { id: piedra, cantidad: 1 }] })
    const [l1, l2] = await lineasDe(id)
    await VentasModel.actualizarVenta(id, { metodoPago: 'efectivo', fechaCompra: '2026-11-10',
      lineas: [{ id: l1.id, cantidad: 3, precio: 1000 }, { id: l2.id, cantidad: 1, precio: 2500 }] })
    assert.deepEqual(await stockDe(arena), { actual: 97, pendiente: 0 })
    assert.deepEqual(await stockDe(piedra), { actual: 99, pendiente: 0 })
    const op = await fila(id)
    assert.equal(Number(op.monto_total), 5500)
    assert.equal(op.fecha_entrega_planificada, null, 'cantera no tiene fecha de envío')
    assert.equal(op.domicilio_calle, null)
    assert.equal(op.obra, null)
  })

  it('el stock queda en 0 como mínimo', async () => {
    const prod = await producto({ stock: 3 })
    const id = await viajeEntregado({ prod, cantidad: 2, precio: 1000 })
    assert.equal((await stockDe(prod)).actual, 1)
    await VentasModel.actualizarVenta(id, { ...base, cantidad: 12, precioProducto: 1000 })
    assert.deepEqual(await stockDe(prod), { actual: 0, pendiente: 0 })
  })

  it('producto sin control de stock y contenedor no mueven stock', async () => {
    const sinControl = await producto({ dependeStock: 0 })
    const contenedor = await producto({ dependeStock: 0, esContenedor: 1, nombre: 'Contenedor prueba entregada' })
    for (const prod of [sinControl, contenedor]) {
      const id = await viajeEntregado({ prod, cantidad: 2, precio: 1000 })
      const antes = await stockDe(prod)
      await VentasModel.actualizarVenta(id, { ...base, cantidad: 5, precioProducto: 1000 })
      assert.deepEqual(await stockDe(prod), antes)
      assert.equal(Number((await fila(id)).monto_total), 5000)
    }
  })

  it('pendiente y despachada siguen moviendo el pendiente', async () => {
    const prod = await producto()
    const id = await crearViaje({ prod, cantidad: 2, precio: 1000 })
    assert.deepEqual(await stockDe(prod), { actual: 100, pendiente: 2 })
    const r = await VentasModel.actualizarVenta(id, { ...base, cantidad: 3, precioProducto: 1000 })
    assert.equal(r.entregada, false)
    assert.deepEqual(await stockDe(prod), { actual: 100, pendiente: 3 })
  })

  // ── facturada y anulada ─────────────────────────────────────
  it('facturada: rechaza cambiar el precio y no guarda nada', async () => {
    const prod = await producto()
    const id = await viajeEntregado({ prod, cantidad: 2, precio: 1000 })
    await prueba.q(`UPDATE op_encabezado SET facturado = 1 WHERE id = ?`, [id])
    await assert.rejects(() => VentasModel.actualizarVenta(id, { ...base, calle: 'Otra', cantidad: 2, precioProducto: 1500 }), /facturada/)
    assert.equal(Number((await fila(id)).monto_total), 2000)
    assert.equal((await fila(id)).domicilio_calle, 'Colón', 'la edición completa se deshizo')
    assert.deepEqual(await stockDe(prod), { actual: 98, pendiente: 0 })
  })

  it('facturada: sí deja editar lo que no cambia el monto', async () => {
    const prod = await producto()
    const id = await viajeEntregado({ prod, cantidad: 2, precio: 1000 })
    await prueba.q(`UPDATE op_encabezado SET facturado = 1 WHERE id = ?`, [id])
    await VentasModel.actualizarVenta(id, { ...base, calle: 'Otra', cantidad: 2, precioProducto: 1000 })
    assert.equal((await fila(id)).domicilio_calle, 'Otra')
  })

  it('anulada: sigue sin poder editarse', async () => {
    const prod = await producto()
    const id = await crearViaje({ prod })
    await VentasModel.anular(id)
    await assert.rejects(() => VentasModel.actualizarVenta(id, { ...base, cantidad: 3, precioProducto: 1000 }), /anulada/)
  })

  // ── descripción de cantera ──────────────────────────────────
  describe('descripción de cantera', () => {
    const cantera2 = async () => {
      const prod = await producto()
      const id = await canteraEntregada({ items: [{ id: prod, cantidad: 2 }] })
      assert.equal((await fila(id)).observaciones, 'Arena prueba entregada x2')
      return { id, linea: (await lineasDe(id))[0] }
    }
    const editar = (id, linea, descripcion) => VentasModel.actualizarVenta(id, {
      metodoPago: 'efectivo', descripcion, lineas: [{ id: linea.id, cantidad: 3, precio: 1000 }] })

    it('la parte automática se reescribe con la cantidad nueva', async () => {
      const { id, linea } = await cantera2()
      await editar(id, linea, 'Arena prueba entregada x2')
      assert.equal((await fila(id)).observaciones, 'Arena prueba entregada x3')
    })
    it('la nota que sigue a la parte automática se conserva', async () => {
      const { id, linea } = await cantera2()
      await editar(id, linea, 'Arena prueba entregada x2 — Obra norte')
      assert.equal((await fila(id)).observaciones, 'Arena prueba entregada x3 — Obra norte')
    })
    it('un texto escrito a mano no se toca', async () => {
      const { id, linea } = await cantera2()
      await editar(id, linea, 'Entrega especial')
      assert.equal((await fila(id)).observaciones, 'Entrega especial')
    })
  })

  // ── el cobro acompaña ───────────────────────────────────────
  describe('el cobro acompaña', () => {
    const tercero = { categoria: 'otro', concepto: 'Tercero prueba' }
    const txsDe = async (id) => (await prueba.q(`SELECT * FROM transacciones WHERE id_op_encabezado = ? ORDER BY id`, [id])).rows
    const egresosDe = async (txId) => (await prueba.q(`SELECT * FROM egresos WHERE id_transaccion = ? AND origen = 'tercero' ORDER BY id`, [txId])).rows
    const cargosDe = async (id) => (await prueba.q(`SELECT tipo, monto FROM movimientos_cuenta WHERE id_op_encabezado = ? AND tipo IN ('deuda', 'uso_saldo_favor') ORDER BY id`, [id])).rows
    const saldoDe = async (cli) => Number((await prueba.q(`SELECT saldo FROM clientes WHERE id = ?`, [cli])).rows[0].saldo)
    const auditorias = async (id) => (await prueba.q(`SELECT * FROM auditoria WHERE entidad_tipo = 'operacion' AND entidad_id = ? AND accion = 'editar_entregada' ORDER BY id`, [id])).rows

    it('efectivo: el monto cambia y la fecha de cobro no', async () => {
      const prod = await producto()
      const id = await viajeEntregado({ prod, cantidad: 2, precio: 1000 })
      const [antes] = await txsDe(id)
      const r = await VentasModel.actualizarVenta(id, { ...base, cantidad: 5, precioProducto: 1000 })
      const txs = await txsDe(id)
      assert.equal(txs.length, 1)
      assert.equal(String(txs[0].id), String(antes.id), 'se corrige la misma transacción')
      assert.equal(Number(txs[0].monto), 5000)
      assert.equal(String(txs[0].fecha), String(antes.fecha), 'la fecha de cobro no se toca')
      assert.equal(txs[0].descripcion, VentasModel.descripcionDeCobro(await fila(id)))
      assert.equal(r.cobroCorregido, true)
    })

    it('sin cambios de lo cobrado: la transacción, el egreso y la auditoría quedan como estaban', async () => {
      const prod = await producto()
      const id = await viajeEntregado({ prod, cantidad: 2, precio: 1000, metodo: 'transferencia', tercero })
      const [antes] = await txsDe(id)
      assert.equal(antes.descripcion, VentasModel.descripcionDeCobro(await fila(id)), 'la descripción que arma la entrega es la que arma el modelo')
      const [egreso] = await egresosDe(antes.id)
      assert.ok(egreso, 'la entrega por transferencia con tercero generó su egreso')
      const guardar = () => VentasModel.actualizarVenta(id, { ...base, metodoPago: 'transferencia', cantidad: 2, precioProducto: 1000, descripcion: '' }, { usuario: admin })
      const r = await guardar()
      assert.equal(r.cobroCorregido, false)
      assert.deepEqual((await txsDe(id))[0], antes)
      const despues = await egresosDe(antes.id)
      assert.equal(despues.length, 1)
      assert.equal(String(despues[0].id), String(egreso.id), 'el egreso no se rehace')
      assert.equal((await auditorias(id)).length, 0)
    })

    it('para facturar: la transacción lleva el IVA', async () => {
      const prod = await producto()
      const id = await viajeEntregado({ prod, cantidad: 1, precio: 1000, iva: 21 })
      assert.equal(Number((await txsDe(id))[0].monto), 1210)
      await VentasModel.actualizarVenta(id, { ...base, cantidad: 1, precioProducto: 2000 })
      assert.equal(Number((await txsDe(id))[0].monto), 2420)
    })

    it('efectivo → cuenta corriente: el método de la transacción y el cargo acompañan', async () => {
      const cc = await datos.crearCliente({ cuentaCorriente: true })
      const prod = await producto()
      const id = await viajeEntregado({ prod, cantidad: 2, precio: 1000, cli: cc })
      await VentasModel.actualizarVenta(id, { ...base, metodoPago: 'cuenta_corriente', cantidad: 2, precioProducto: 1000 })
      assert.equal((await txsDe(id))[0].metodo_pago, 'cuenta_corriente')
      const cargos = await cargosDe(id)
      assert.equal(cargos.length, 1)
      assert.equal(cargos[0].tipo, 'deuda')
      assert.equal(Number(cargos[0].monto), -2000)
      assert.equal(await saldoDe(cc), -2000)
    })

    it('pasar a cuenta corriente un cliente sin cuenta corriente rechaza y no cambia nada', async () => {
      const prod = await producto()
      const id = await viajeEntregado({ prod, cantidad: 2, precio: 1000 })
      await assert.rejects(() => VentasModel.actualizarVenta(id, { ...base, metodoPago: 'cuenta_corriente', cantidad: 5, precioProducto: 1000 }))
      assert.deepEqual(await stockDe(prod), { actual: 98, pendiente: 0 })
      assert.equal(Number((await fila(id)).monto_total), 2000)
      const tx = (await txsDe(id))[0]
      assert.equal(Number(tx.monto), 2000)
      assert.equal(tx.metodo_pago, 'efectivo')
    })

    it('cuenta corriente con un pago ya aplicado: el cargo cambia y el saldo queda coherente', async () => {
      const cc = await datos.crearCliente({ cuentaCorriente: true })
      const prod = await producto()
      const id = await viajeEntregado({ prod, cantidad: 2, precio: 1000, metodo: 'cuenta_corriente', cli: cc })
      assert.equal(await saldoDe(cc), -2000)
      await ClientesModel.agregarMovimiento(cc, { tipo: 'pago', descripcion: 'Pago', monto: 500, metodo_pago: 'efectivo' })
      assert.equal(await saldoDe(cc), -1500)
      await VentasModel.actualizarVenta(id, { ...base, metodoPago: 'cuenta_corriente', cantidad: 1, precioProducto: 3000 })
      const cargos = await cargosDe(id)
      assert.equal(cargos.length, 1)
      assert.equal(Number(cargos[0].monto), -3000)
      assert.equal(await saldoDe(cc), -2500)
    })

    it('transferencia con tercero: el egreso sigue al monto y desaparece si deja de ser transferencia', async () => {
      const prod = await producto()
      const id = await viajeEntregado({ prod, cantidad: 2, precio: 1000, metodo: 'transferencia', tercero })
      const [tx] = await txsDe(id)
      await VentasModel.actualizarVenta(id, { ...base, metodoPago: 'transferencia', cantidad: 5, precioProducto: 1000 })
      const egresos = await egresosDe(tx.id)
      assert.equal(egresos.length, 1)
      assert.equal(Number(egresos[0].monto), 5000)
      await VentasModel.actualizarVenta(id, { ...base, metodoPago: 'efectivo', cantidad: 5, precioProducto: 1000, tercero: null })
      assert.equal((await egresosDe(tx.id)).length, 0)
      assert.equal((await txsDe(id))[0].metodo_pago, 'efectivo')
    })

    it('dejada pendiente de cobro (sin transacción): solo cambia el total', async () => {
      const prod = await producto()
      const id = await viajeEntregado({ prod, cantidad: 2, precio: 1000 })
      await prueba.q(`DELETE FROM transacciones WHERE id_op_encabezado = ?`, [id])
      const r = await VentasModel.actualizarVenta(id, { ...base, cantidad: 5, precioProducto: 1000 })
      assert.equal((await txsDe(id)).length, 0, 'no se inventa un cobro')
      assert.equal(Number((await fila(id)).monto_total), 5000)
      assert.equal(r.cobroCorregido, false)
    })

    it('con dos cobros, el cambio de monto va al último', async () => {
      const prod = await producto()
      const id = await viajeEntregado({ prod, cantidad: 2, precio: 1000 })
      await prueba.q(`UPDATE transacciones SET monto = 1500 WHERE id_op_encabezado = ?`, [id])
      await TransaccionesModel.crear({ tipo: 'Venta Viaje', id_op_encabezado: id, cliente_id: cliente, cliente: 'PRUEBA', monto: 500, metodo_pago: 'efectivo' })
      await VentasModel.actualizarVenta(id, { ...base, cantidad: 3, precioProducto: 1000 })
      assert.deepEqual((await txsDe(id)).map(t => Number(t.monto)), [1500, 1500])
    })

    it('IVA agregado después de cobrar: la diferencia pendiente se conserva', async () => {
      const prod = await producto()
      const id = await viajeEntregado({ prod, cantidad: 2, precio: 1000 })
      await prueba.q(`UPDATE op_encabezado SET para_facturar = 1, iva_alicuota = 21 WHERE id = ?`, [id])
      assert.equal(Number((await txsDe(id))[0].monto), 2000, 'lo cobrado no cambió (el IVA quedó como saldo)')
      await VentasModel.actualizarVenta(id, { ...base, cantidad: 3, precioProducto: 1000 })
      // total 3630 (antes 2420): lo cobrado sube por la diferencia, no se iguala al total
      assert.equal(Number((await txsDe(id))[0].monto), 3210)
    })

    it('auditoría: queda el monto anterior solo si cambió algo de dinero o stock', async () => {
      const prod = await producto()
      const id = await viajeEntregado({ prod, cantidad: 2, precio: 1000 })
      await VentasModel.actualizarVenta(id, { ...base, calle: 'Otra', cantidad: 2, precioProducto: 1000 }, { usuario: admin })
      assert.equal((await auditorias(id)).length, 0, 'cambiar solo la dirección no audita')
      await VentasModel.actualizarVenta(id, { ...base, cantidad: 3, precioProducto: 1000 }, { usuario: admin })
      const filas = await auditorias(id)
      assert.equal(filas.length, 1)
      assert.equal(String(filas[0].id_usuario), String(admin))
      const det = JSON.parse(filas[0].detalle)
      assert.equal(det.antes.total, 2000)
      assert.equal(det.despues.total, 3000)
      assert.equal(det.antes.metodo_pago, 'efectivo')
    })
  })
})
