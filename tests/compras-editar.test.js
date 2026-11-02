'use strict'
// Ver y editar una compra / pago desde Compras / Pagos. Editar corrige todo lo que la
// operación movió: el stock y el ingreso de stock (material), el pago del empleado y su
// recibo (sueldo) y la carga del camión (combustible que impacta en el camión).
// Corre dentro de la transacción de prueba (ROLLBACK al final: nada queda guardado).
const prueba = require('./helpers/db')
const datos = require('./helpers/datos')
const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { renderVista } = require('./helpers/vistas')
const ComprasController = require('../src/controllers/compras.controller')
const EstacionesModel = require('../src/models/estaciones.model')

function llamar(accion, { body = {}, params = {}, query = {}, user }) {
  return new Promise((resolve, reject) => {
    const flashes = []
    const req = { body, params, query, session: { user }, flash: (tipo, msg) => flashes.push({ tipo, msg }), get: () => null }
    const res = { locals: {}, redirect: (url) => resolve({ url, flashes }), render: (vista, data) => resolve({ vista, data, flashes }) }
    Promise.resolve(ComprasController[accion](req, res)).catch(reject)
  })
}

let user
const stock = async (id) => Number((await prueba.q(`SELECT cantidad_actual FROM stock WHERE id_producto = ?`, [id])).rows[0].cantidad_actual)
const egreso = async (id) => (await prueba.q(`SELECT * FROM egresos WHERE id = ?`, [id])).rows[0]
const ultimoId = async (categoria) => (await prueba.q(`SELECT id FROM egresos WHERE categoria = ? ORDER BY id DESC LIMIT 1`, [categoria])).rows[0].id

before(async () => {
  await prueba.abrir()
  user = { id: await datos.idAdministrativo(), rol: 'dueno' }
})
after(() => prueba.cerrar())

describe('editar una compra de material', () => {
  let arena, piedra, provA, provB, id

  before(async () => {
    const producto = async (nombre) => (await prueba.q(
      `INSERT INTO productos (nombre, unidad_medida, activo) VALUES (?, 'tn', 1) RETURNING id`, [nombre])).rows[0].id
    arena = await producto('Arena prueba editar')
    piedra = await producto('Piedra prueba editar')
    await prueba.q(`INSERT INTO stock (id_producto, cantidad_actual) VALUES (?, 0), (?, 0) ON CONFLICT DO NOTHING`, [arena, piedra])
    const proveedor = async (nombre) => (await prueba.q(`INSERT INTO proveedores (nombre) VALUES (?) RETURNING id`, [nombre])).rows[0].id
    provA = await proveedor('Proveedor A prueba editar')
    provB = await proveedor('Proveedor B prueba editar')
    await llamar('crear', { user, body: {
      categoria: 'material', fecha: '2026-10-10', metodo_pago: 'efectivo', id_producto: String(arena), id_proveedor: String(provA),
      cantidad: '100', costo_unitario: '1000', costo_flete: '100', descripcion: 'Mal cargada' } })
    id = await ultimoId('material')
    assert.equal(await stock(arena), 100)
  })

  it('el alta suma al stock y registra el ingreso con la fecha de la compra', async () => {
    const e = await egreso(id)
    const ing = (await prueba.q(`SELECT * FROM stock_ingresos WHERE id = ?`, [e.id_stock_ingreso])).rows[0]
    assert.equal(ing.fecha, '2026-10-10')
    assert.equal(Number(ing.cantidad), 100)
    assert.equal(ing.observaciones, 'Mal cargada')
  })

  it('el formulario de edición viene con los datos de la compra', async () => {
    const v = await llamar('editar', { user, params: { id } })
    assert.equal(v.vista, 'pages/compras/form')
    const html = await renderVista(v.vista, { ...v.data, scripts: [] })
    assert.match(html, new RegExp(`action="/compras/${id}\\?_method=PUT"`))
    assert.match(html, /name="cantidad" id="cantidad" class="form-control" value="100"/)
    assert.match(html, new RegExp(`<option value="${arena}" selected>`))
    assert.match(html, /Al guardar se corrige también el stock/)
    assert.match(html, /Guardar cambios/)
  })

  it('corregir la cantidad ajusta el stock y el ingreso de stock', async () => {
    const r = await llamar('actualizar', { user, params: { id }, body: {
      categoria: 'material', fecha: '2026-10-11', metodo_pago: 'transferencia', id_producto: String(arena), id_proveedor: String(provB),
      cantidad: '10', costo_unitario: '1200', costo_flete: '50', descripcion: 'Corregida' } })
    assert.equal(r.url, '/compras', JSON.stringify(r.flashes))
    assert.equal(await stock(arena), 10)
    const e = await egreso(id)
    assert.equal(Number(e.cantidad), 10)
    assert.equal(Number(e.subtotal_material), 12000)
    assert.equal(Number(e.costo_final_flete), 500)
    assert.equal(Number(e.monto), 12500)
    assert.equal(e.fecha, '2026-10-11')
    assert.equal(Number(e.id_proveedor), Number(provB))
    const ing = (await prueba.q(`SELECT * FROM stock_ingresos WHERE id = ?`, [e.id_stock_ingreso])).rows[0]
    assert.equal(Number(ing.cantidad), 10)
    assert.equal(Number(ing.costo_unitario), 1200)
    assert.equal(Number(ing.costo_flete), 50)
    assert.equal(Number(ing.id_proveedor), Number(provB))
    assert.equal(ing.fecha, '2026-10-11')
    const a = (await prueba.q(`SELECT * FROM auditoria WHERE entidad_tipo = 'egreso' AND entidad_id = ? AND accion = 'editar'`, [id])).rows
    assert.equal(a.length, 1)
    assert.equal(JSON.parse(a[0].detalle).antes.cantidad, 100)
  })

  it('cambiar el producto saca el stock del anterior y lo suma al nuevo', async () => {
    await llamar('actualizar', { user, params: { id }, body: {
      categoria: 'material', fecha: '2026-10-11', id_producto: String(piedra), cantidad: '10', subtotal_material: '12000', costo_final_flete: '500' } })
    assert.equal(await stock(arena), 0)
    assert.equal(await stock(piedra), 10)
    const ing = (await prueba.q(`SELECT id_producto FROM stock_ingresos WHERE id = (SELECT id_stock_ingreso FROM egresos WHERE id = ?)`, [id])).rows[0]
    assert.equal(Number(ing.id_producto), Number(piedra))
  })

  it('si el stock quedara negativo no guarda nada', async () => {
    await prueba.q(`UPDATE stock SET cantidad_actual = 4 WHERE id_producto = ?`, [piedra])   // salieron 6
    const r = await llamar('actualizar', { user, params: { id }, body: {
      categoria: 'material', fecha: '2026-10-11', id_producto: String(piedra), cantidad: '2', subtotal_material: '2400', costo_final_flete: '0' } })
    assert.equal(r.url, `/compras/${id}/editar`)
    assert.match(r.flashes[0].msg, /quedaría en -4/)
    assert.equal(await stock(piedra), 4)
    assert.equal(Number((await egreso(id)).cantidad), 10)
  })

  it('el listado ofrece Ver compra (con el detalle) y Editar compra', async () => {
    const v = await llamar('index', { user, query: { preset: 'rango', fechaDesde: '2026-10-01', fechaHasta: '2026-10-31', categoria: 'material' } })
    const html = await renderVista(v.vista, { ...v.data, scripts: [] })
    assert.match(html, /title="Ver compra"/)
    assert.match(html, new RegExp(`href="/compras/${id}/editar"`))
    assert.match(html, /id="modalVerCompra"/)
    assert.match(html, /Ingresó al stock/)
    assert.match(html, /Última edición/)
    assert.match(html, /Se descuenta del stock lo que entró \(10 tn de Piedra prueba editar\)/)
  })

  it('eliminar no borra nada si el stock quedara negativo', async () => {
    // stock de piedra en 4 (de la prueba anterior) y la compra había entrado 10
    const r = await llamar('eliminar', { user, params: { id } })
    assert.match(r.flashes[0].msg, /Al eliminar esta compra, el stock de Piedra prueba editar quedaría en -6/)
    assert.ok(await egreso(id))
    assert.equal(await stock(piedra), 4)
  })

  it('eliminar descuenta del stock lo que entró y borra el ingreso de stock', async () => {
    await prueba.q(`UPDATE stock SET cantidad_actual = 15 WHERE id_producto = ?`, [piedra])
    const { id_stock_ingreso } = await egreso(id)
    const r = await llamar('eliminar', { user, params: { id } })
    assert.match(r.flashes[0].msg, /se descontó del stock/)
    assert.equal(await egreso(id), undefined)
    assert.equal(await stock(piedra), 5)
    assert.equal((await prueba.q(`SELECT COUNT(*) AS n FROM stock_ingresos WHERE id = ?`, [id_stock_ingreso])).rows[0].n, '0')
  })
})

describe('editar un sueldo', () => {
  it('corrige el pago de la ficha del empleado (y su recibo) y el egreso', async () => {
    const emp = (await datos.crearChofer()).id_empleado
    await llamar('crear', { user, body: { categoria: 'sueldo', id_empleado: String(emp), periodo: '2026-10', monto: '500000', fecha: '2026-10-31', metodo_pago: 'efectivo' } })
    const id = await ultimoId('sueldo')
    const { id_pago_empleado } = await egreso(id)
    const r = await llamar('actualizar', { user, params: { id }, body: {
      categoria: 'sueldo', id_empleado: String(emp), periodo: '2026-09', monto: '520000', descuentos: '20000', adiciones: '5000',
      fecha: '2026-10-30', metodo_pago: 'transferencia', descripcion: 'Corregido' } })
    assert.equal(r.url, '/compras', JSON.stringify(r.flashes))
    const p = (await prueba.q(`SELECT * FROM pagos_empleado WHERE id = ?`, [id_pago_empleado])).rows[0]
    assert.equal(Number(p.monto), 505000)
    assert.equal(Number(p.sueldo_base), 520000)
    assert.equal(p.periodo, '2026-09')
    assert.equal(p.metodo_pago, 'transferencia')
    const e = await egreso(id)
    assert.equal(Number(e.monto), 505000)
    assert.equal(e.fecha, '2026-10-30')
    assert.match(e.descripcion, /\(2026-09\) — Corregido/)
  })
})

describe('editar un pago de combustible con carga en el camión', () => {
  let camion, estacion, chofer, id

  before(async () => {
    await prueba.q(`UPDATE categorias_egreso SET campos = ? WHERE clave = 'combustible'`, [JSON.stringify(['vehiculo', 'estacion', 'carga'])])
    camion = (await prueba.q(`INSERT INTO flota_vehiculos (nombre, patente, tipo_vehiculo) VALUES ('Camión prueba editar', 'ZZ996ZZ', 'camion') RETURNING id`)).rows[0].id
    estacion = (await prueba.q(`INSERT INTO proveedores (nombre, es_estacion) VALUES ('Estación Prueba Editar', 1) RETURNING id`)).rows[0].id
    chofer = (await datos.crearChofer()).id_empleado
    await llamar('crear', { user, body: { categoria: 'combustible', fecha: '2026-10-25', monto: '90000', id_vehiculo: String(camion),
      id_proveedor: String(estacion), id_chofer: String(chofer), litros: '75', impacta_flota: '1' } })
    id = await ultimoId('combustible')
  })

  const cuerpo = (extra) => ({ categoria: 'combustible', fecha: '2026-10-26', monto: '100000', id_vehiculo: String(camion),
    id_proveedor: String(estacion), id_chofer: String(chofer), litros: '80', hora: '09:10', nro_factura: 'F-9', ...extra })

  it('corrige la carga junto con el pago (y la deuda con la estación sigue en cero)', async () => {
    const r = await llamar('actualizar', { user, params: { id }, body: cuerpo({ impacta_flota: '1', km_al_cargar: '2000' }) })
    assert.equal(r.url, '/compras', JSON.stringify(r.flashes))
    const e = await egreso(id)
    const c = (await prueba.q(`SELECT * FROM combustible WHERE id = ?`, [e.id_combustible])).rows[0]
    assert.equal(Number(c.costo_total), 100000)
    assert.equal(Number(c.litros), 80)
    assert.equal(c.fecha, '2026-10-26')
    assert.equal(c.hora, '09:10')
    assert.equal(c.nro_factura, 'F-9')
    assert.equal(Number(c.km_al_cargar), 2000)
    assert.equal((await EstacionesModel.cuenta(estacion)).saldo, 0)
  })

  it('destildar "Impacta en autonomía del camión" borra la carga', async () => {
    const antes = (await egreso(id)).id_combustible
    await llamar('actualizar', { user, params: { id }, body: cuerpo({}) })
    assert.equal((await egreso(id)).id_combustible, null)
    assert.equal((await prueba.q(`SELECT COUNT(*) AS n FROM combustible WHERE id = ?`, [antes])).rows[0].n, '0')
  })

  it('volver a tildarlo crea la carga de nuevo', async () => {
    await llamar('actualizar', { user, params: { id }, body: cuerpo({ impacta_flota: '1' }) })
    const e = await egreso(id)
    assert.ok(e.id_combustible)
    assert.equal(Number((await prueba.q(`SELECT litros FROM combustible WHERE id = ?`, [e.id_combustible])).rows[0].litros), 80)
  })
})

describe('lo que no se edita desde Compras / Pagos', () => {
  it('la transferencia de un cliente a un tercero', async () => {
    const id = (await prueba.q(`INSERT INTO egresos (fecha, categoria, monto, origen) VALUES ('2026-10-20', 'otro', 100, 'tercero') RETURNING id`)).rows[0].id
    const r = await llamar('editar', { user, params: { id } })
    assert.equal(r.url, '/compras')
    assert.match(r.flashes[0].msg, /tercero/)
    const r2 = await llamar('actualizar', { user, params: { id }, body: { monto: '1' } })
    assert.equal(r2.url, '/compras')
    assert.equal(Number((await egreso(id)).monto), 100)
    const r3 = await llamar('eliminar', { user, params: { id } })
    assert.match(r3.flashes[0].msg, /tercero/)
    assert.ok(await egreso(id))
  })
})
