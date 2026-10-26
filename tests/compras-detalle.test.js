'use strict'
// Detalle de las compras de material en el libro de compras / pagos: cada compra guarda su
// cantidad, subtotal y flete; las viejas se recuperan del ingreso de stock que generaron;
// el resumen suma la cantidad por producto y proveedor según los filtros.
// Corre dentro de la transacción de prueba (ROLLBACK al final: nada queda guardado).
const prueba = require('./helpers/db')
const datos = require('./helpers/datos')
const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const db = require('../src/config/db')
const ComprasController = require('../src/controllers/compras.controller')
const EgresosModel = require('../src/models/egresos.model')

function llamar(accion, { body = {}, user }) {
  return new Promise((resolve, reject) => {
    const flashes = []
    const req = { body, params: {}, query: {}, session: { user }, flash: (tipo, msg) => flashes.push({ tipo, msg }) }
    const res = { redirect: (url) => resolve({ url, flashes }), render: (vista, data) => resolve({ vista, data, flashes }) }
    Promise.resolve(ComprasController[accion](req, res)).catch(reject)
  })
}

describe('detalle de las compras de material', () => {
  let user, arena, piedra, provA, provB

  before(async () => {
    await prueba.abrir()
    user = { id: await datos.idAdministrativo(), rol: 'dueno' }
    const producto = async (nombre, unidad) => (await prueba.q(
      `INSERT INTO productos (nombre, unidad_medida, activo) VALUES (?, ?, 1) RETURNING id`, [nombre, unidad])).rows[0].id
    arena = await producto('Arena prueba detalle', 'tn')
    piedra = await producto('Piedra prueba detalle', 'm³')
    await prueba.q(`INSERT INTO stock (id_producto, cantidad_actual) VALUES (?, 0), (?, 0) ON CONFLICT DO NOTHING`, [arena, piedra])
    const proveedor = async (nombre) => (await prueba.q(`INSERT INTO proveedores (nombre) VALUES (?) RETURNING id`, [nombre])).rows[0].id
    provA = await proveedor('Proveedor A prueba')
    provB = await proveedor('Proveedor B prueba')
  })
  after(() => prueba.cerrar())

  const comprar = (extra) => llamar('crear', { user, body: {
    categoria: 'material', fecha: '2026-10-10', metodo_pago: 'efectivo', ...extra,
  } })
  const ultimo = async () => (await prueba.q(`SELECT * FROM egresos WHERE categoria = 'material' ORDER BY id DESC LIMIT 1`)).rows[0]

  it('registrar una compra guarda cantidad, subtotal, flete y el vínculo con el ingreso de stock', async () => {
    const r = await comprar({ id_producto: arena, id_proveedor: provA, cantidad: '40', costo_unitario: '1000', costo_flete: '100' })
    assert.equal(r.url, '/compras')
    const e = await ultimo()
    assert.equal(Number(e.cantidad), 40)
    assert.equal(Number(e.subtotal_material), 40000)
    assert.equal(Number(e.costo_final_flete), 4000)
    assert.equal(Number(e.monto), 44000)
    const ingreso = (await prueba.q(`SELECT * FROM stock_ingresos WHERE id = ?`, [e.id_stock_ingreso])).rows[0]
    assert.equal(Number(ingreso.cantidad), 40)
    assert.equal(String(ingreso.id_proveedor), String(provA))
  })

  it('con subtotal y flete editados a mano se guardan esos valores', async () => {
    await comprar({ id_producto: arena, id_proveedor: provA, cantidad: '10', costo_unitario: '1000', subtotal_material: '9500', costo_final_flete: '700' })
    const e = await ultimo()
    assert.equal(Number(e.subtotal_material), 9500)
    assert.equal(Number(e.costo_final_flete), 700)
    assert.equal(Number(e.monto), 10200)
  })

  it('el listado trae la unidad del producto y el resumen suma por producto y proveedor', async () => {
    await comprar({ id_producto: arena, id_proveedor: provB, cantidad: '5', costo_unitario: '2000' })
    await comprar({ id_producto: piedra, id_proveedor: provA, cantidad: '3', costo_unitario: '500' })
    const filtros = { fechaDesde: '2026-10-01', fechaHasta: '2026-10-31' }
    const lista = await EgresosModel.listar(filtros)
    assert.ok(lista.find(e => e.producto_nombre === 'Arena prueba detalle' && e.producto_unidad === 'tn'))

    const { material, materialSinCantidad } = (await EgresosModel.resumen(filtros))
    const a = material.find(g => String(g.id_producto) === String(arena))
    assert.equal(a.cantidad, 55)                       // 40 + 10 + 5, sin mezclar con la piedra
    assert.equal(a.unidad, 'tn')
    assert.equal(a.proveedores.find(p => String(p.id) === String(provA)).cantidad, 50)
    assert.equal(a.proveedores.find(p => String(p.id) === String(provB)).cantidad, 5)
    assert.equal(material.find(g => String(g.id_producto) === String(piedra)).cantidad, 3)
    assert.equal(materialSinCantidad, 0)
  })

  it('el resumen respeta los filtros de proveedor, producto y categoría', async () => {
    const soloB = await EgresosModel.resumen({ id_proveedor: provB })
    assert.equal(soloB.material.length, 1)
    assert.equal(soloB.material[0].cantidad, 5)
    const piedras = await EgresosModel.resumen({ id_producto: piedra })
    assert.deepEqual(piedras.material.map(g => g.cantidad), [3])
    const otraCategoria = await EgresosModel.resumen({ categoria: 'seguro' })
    assert.deepEqual(otraCategoria.material, [])
  })

  describe('compras viejas (sin detalle)', () => {
    // Una compra vieja: ingreso de stock y egreso sin cantidad, creados en el mismo momento.
    const vieja = async ({ producto = arena, prov = provA, cant, unit, flete = 0, monto, momento = '2026-09-02 10:00:00', conProducto = true }) => {
      const ingreso = (await prueba.q(`
        INSERT INTO stock_ingresos (id_producto, id_proveedor, cantidad, costo_unitario, costo_flete, created_at)
        VALUES (?, ?, ?, ?, ?, ?) RETURNING id`, [producto, prov, cant, unit, flete, momento])).rows[0].id
      const egreso = (await prueba.q(`
        INSERT INTO egresos (fecha, categoria, monto, id_proveedor, id_producto, created_at)
        VALUES ('2026-09-02', 'material', ?, ?, ?, ?) RETURNING id`, [monto ?? cant * (unit + flete), prov, conProducto ? producto : null, momento])).rows[0].id
      return { ingreso, egreso }
    }
    const egreso = async (id) => (await prueba.q(`SELECT * FROM egresos WHERE id = ?`, [id])).rows[0]

    it('se vinculan con su ingreso: cantidad, subtotal y flete salen del stock', async () => {
      const v = await vieja({ cant: 20, unit: 1500, flete: 200 })
      assert.ok(await db.vincularComprasConStock() >= 1)
      const e = await egreso(v.egreso)
      assert.equal(Number(e.cantidad), 20)
      assert.equal(Number(e.subtotal_material), 30000)
      assert.equal(Number(e.costo_final_flete), 4000)
      assert.equal(String(e.id_stock_ingreso), String(v.ingreso))
    })

    it('una compra vieja sin producto lo recupera del ingreso', async () => {
      const v = await vieja({ producto: piedra, cant: 8, unit: 900, conProducto: false, momento: '2026-09-03 11:00:00' })
      await db.vincularComprasConStock()
      assert.equal(String((await egreso(v.egreso)).id_producto), String(piedra))
    })

    it('dos compras iguales cada una con su ingreso: no se cruzan, cada una toma el suyo', async () => {
      const a = await vieja({ cant: 12, unit: 1000, momento: '2026-09-04 09:00:00' })
      const b = await vieja({ cant: 12, unit: 1000, momento: '2026-09-04 15:00:00' })
      await db.vincularComprasConStock()
      assert.equal(String((await egreso(a.egreso)).id_stock_ingreso), String(a.ingreso))
      assert.equal(String((await egreso(b.egreso)).id_stock_ingreso), String(b.ingreso))
    })

    it('si el monto no coincide con ningún ingreso, queda sin cantidad', async () => {
      const v = await vieja({ cant: 7, unit: 1000, monto: 99999, momento: '2026-09-05 09:00:00' })
      await db.vincularComprasConStock()
      assert.equal((await egreso(v.egreso)).cantidad, null)
    })

    it('si el ingreso se creó mucho antes o después, tampoco se vincula', async () => {
      const ingreso = (await prueba.q(`
        INSERT INTO stock_ingresos (id_producto, id_proveedor, cantidad, costo_unitario, costo_flete, created_at)
        VALUES (?, ?, 9, 1111, 0, '2026-08-01 08:00:00') RETURNING id`, [arena, provB])).rows[0].id
      const e = (await prueba.q(`
        INSERT INTO egresos (fecha, categoria, monto, id_proveedor, id_producto, created_at)
        VALUES ('2026-08-05', 'material', 9999, ?, ?, '2026-08-05 08:00:00') RETURNING id`, [provB, arena])).rows[0].id
      await db.vincularComprasConStock()
      assert.equal((await egreso(e)).cantidad, null)
      assert.equal((await prueba.q(`SELECT 1 FROM egresos WHERE id_stock_ingreso = ?`, [ingreso])).rowCount, 0)
    })

    it('es idempotente: correrla de nuevo no cambia nada', async () => {
      assert.equal(await db.vincularComprasConStock(), 0)
    })

    it('las que no se pudieron vincular se cuentan aparte en el resumen', async () => {
      const { materialSinCantidad } = await EgresosModel.resumen({ fechaDesde: '2026-09-01', fechaHasta: '2026-09-30' })
      assert.equal(materialSinCantidad, 1)
    })
  })
})
