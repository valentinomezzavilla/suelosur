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
  const crearViaje = async ({ prod, cantidad = 2, precio = 1000, metodo = 'efectivo', cli = cliente }) => (await VentasModel.crear({
    id_cliente: cli, id_administrativo: admin, tipo_op: 'M', modalidad: 'flete', metodo_pago: metodo,
    fecha_emision: '2026-11-10', fecha_entrega_planificada: '2026-11-20', domicilio: { calle: 'Colón', altura: '100' }, obra: null,
    precio_flete: 0, monto_total: cantidad * precio, detalles: [{ id_producto: prod, cantidad_pedida: cantidad, precio_unitario: precio }],
  })).id
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
})
