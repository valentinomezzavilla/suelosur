'use strict'
// Combustible en Compras / Pagos con los datos de la carga (hora, N° de factura, N° de remito,
// litros y chofer) y "Impacta en autonomía del camión": el pago crea además la carga en Flota,
// que suma a la deuda con la estación mientras el pago la cancela; se eliminan juntos.
// Corre dentro de la transacción de prueba (ROLLBACK al final: nada queda guardado).
const prueba = require('./helpers/db')
const datos = require('./helpers/datos')
const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { renderVista } = require('./helpers/vistas')
const ComprasController = require('../src/controllers/compras.controller')
const FlotaController = require('../src/controllers/flota.controller')
const ProveedoresController = require('../src/controllers/proveedores.controller')
const EstacionesModel = require('../src/models/estaciones.model')
const CategoriasEgresoModel = require('../src/models/categoriasEgreso.model')

function llamar(ctrl, accion, { body = {}, params = {}, query = {}, user }) {
  return new Promise((resolve, reject) => {
    const flashes = []
    const req = { body, params, query, session: { user }, flash: (tipo, msg) => flashes.push({ tipo, msg }), get: () => null }
    const res = { locals: {}, redirect: (url) => resolve({ url, flashes }), render: (vista, data) => resolve({ vista, data, flashes }) }
    Promise.resolve(ctrl[accion](req, res)).catch(reject)
  })
}

let user, camion, estacion, chofer
before(async () => {
  await prueba.abrir()
  user = { id: await datos.idAdministrativo(), rol: 'dueno' }
  // La migración combustible_carga_v1 corre al arrancar la app: acá se aplica a mano
  await prueba.q(`UPDATE categorias_egreso SET campos = ? WHERE clave = 'combustible'`, [JSON.stringify(['vehiculo', 'estacion', 'carga'])])
  camion = (await prueba.q(`INSERT INTO flota_vehiculos (nombre, patente, tipo_vehiculo, kilometraje) VALUES ('Camión prueba compras', 'ZZ997ZZ', 'camion', 1000) RETURNING id`)).rows[0].id
  await llamar(ProveedoresController, 'crear', { user, body: { nombre: 'Estación Prueba Compras', es_estacion: '1' } })
  estacion = (await prueba.q(`SELECT id FROM proveedores WHERE nombre = 'Estación Prueba Compras'`)).rows[0].id
  chofer = (await datos.crearChofer()).id_empleado
  await prueba.q(`UPDATE empleados SET es_chofer = 1 WHERE id = ?`, [chofer])
})
after(() => prueba.cerrar())

const base = () => ({
  categoria: 'combustible', fecha: '2026-10-25', monto: '90000', metodo_pago: 'transferencia',
  id_vehiculo: String(camion), id_proveedor: String(estacion), id_chofer: String(chofer),
  hora: '14:05', nro_factura: ' 0001-00000077 ', nro_remito: 'R-77', litros: '75.5',
})

describe('categoría con el campo "carga"', () => {
  it('"carga" suma vehículo y estación (y saca proveedor)', async () => {
    const id = await CategoriasEgresoModel.crear({ etiqueta: 'Combustible prueba campos', campos: ['carga', 'proveedor'] })
    const c = await CategoriasEgresoModel.obtener(id)
    assert.deepEqual([...c.campos].sort(), ['carga', 'estacion', 'vehiculo'])
  })

  it('el formulario muestra los campos de la carga y el check', async () => {
    const v = await llamar(ComprasController, 'nueva', { user })
    const html = await renderVista(v.vista, { ...v.data, scripts: [] })
    for (const campo of ['hora', 'nro_factura', 'nro_remito', 'litros', 'id_chofer', 'km_al_cargar']) {
      assert.match(html, new RegExp(`name="${campo}"`), `falta el campo ${campo}`)
    }
    assert.match(html, /name="impacta_flota" value="1"/)
    assert.match(html, /Impacta en autonomía del camión/)
  })
})

describe('el chofer es obligatorio siempre', () => {
  it('Compras / Pagos no registra combustible sin chofer (aunque no impacte en el camión)', async () => {
    const r = await llamar(ComprasController, 'crear', { user, body: { ...base(), id_chofer: '' } })
    assert.equal(r.url, '/compras/nueva')
    assert.match(r.flashes[0].msg, /chofer/)
    const n = (await prueba.q(`SELECT COUNT(*) AS n FROM egresos WHERE id_vehiculo = ?`, [camion])).rows[0].n
    assert.equal(Number(n), 0)
  })

  it('Flota no registra una carga sin chofer', async () => {
    const r = await llamar(FlotaController, 'cargarCombustible', { user, params: { id: camion }, body: { litros: '10', costo_total: '1000', id_chofer: '' } })
    assert.match(r.flashes[0].msg, /chofer/)
    const n = (await prueba.q(`SELECT COUNT(*) AS n FROM combustible WHERE id_vehiculo = ?`, [camion])).rows[0].n
    assert.equal(Number(n), 0)
  })

  it('los dos formularios marcan el chofer como obligatorio', async () => {
    const f = await llamar(ComprasController, 'nueva', { user })
    assert.match(await renderVista(f.vista, { ...f.data, scripts: [] }), /<select name="id_chofer" id="selChofer" class="form-select" required>/)
    const v = await llamar(FlotaController, 'detalle', { user, params: { id: camion }, query: { tab: 'combustible', mes: '2026-10' } })
    assert.match(await renderVista(v.vista, { ...v.data, scripts: [] }), /<select name="id_chofer" class="form-select form-select-sm" required>/)
  })
})

describe('pago de combustible sin impactar en el camión', () => {
  it('guarda los datos en el pago y no crea carga', async () => {
    const r = await llamar(ComprasController, 'crear', { user, body: base() })
    assert.equal(r.url, '/compras')
    const e = (await prueba.q(`SELECT * FROM egresos WHERE id_vehiculo = ? ORDER BY id DESC LIMIT 1`, [camion])).rows[0]
    assert.equal(e.hora, '14:05')
    assert.equal(e.nro_factura, '0001-00000077')
    assert.equal(e.nro_remito, 'R-77')
    assert.equal(Number(e.litros), 75.5)
    assert.equal(Number(e.id_chofer), Number(chofer))
    assert.equal(e.id_combustible, null)
    const cargas = (await prueba.q(`SELECT COUNT(*) AS n FROM combustible WHERE id_vehiculo = ?`, [camion])).rows[0]
    assert.equal(Number(cargas.n), 0)
    await prueba.q(`DELETE FROM egresos WHERE id = ?`, [e.id])
  })
})

describe('pago de combustible que impacta en el camión', () => {
  it('pide camión, estación y litros', async () => {
    const r = await llamar(ComprasController, 'crear', { user, body: { ...base(), impacta_flota: '1', id_proveedor: '', litros: '' } })
    assert.equal(r.url, '/compras/nueva')
    assert.match(r.flashes[0].msg, /la estación de servicio y los litros/)
    const n = (await prueba.q(`SELECT COUNT(*) AS n FROM egresos WHERE id_vehiculo = ?`, [camion])).rows[0].n
    assert.equal(Number(n), 0)
  })

  let egresoId, cargaId
  it('crea el pago y la carga vinculados, con los mismos datos', async () => {
    const r = await llamar(ComprasController, 'crear', { user, body: { ...base(), impacta_flota: '1', km_al_cargar: '1500' } })
    assert.equal(r.url, '/compras')
    assert.ok(r.flashes.some(f => f.tipo === 'success'), JSON.stringify(r.flashes))
    const e = (await prueba.q(`SELECT * FROM egresos WHERE id_vehiculo = ? ORDER BY id DESC LIMIT 1`, [camion])).rows[0]
    const c = (await prueba.q(`SELECT * FROM combustible WHERE id_vehiculo = ?`, [camion])).rows[0]
    egresoId = e.id; cargaId = c.id
    assert.equal(Number(e.id_combustible), Number(c.id))
    assert.equal(c.fecha, '2026-10-25')
    assert.equal(c.hora, '14:05')
    assert.equal(c.nro_factura, '0001-00000077')
    assert.equal(c.nro_remito, 'R-77')
    assert.equal(Number(c.litros), 75.5)
    assert.equal(Number(c.costo_total), 90000)
    assert.equal(Number(c.id_chofer), Number(chofer))
    assert.equal(Number(c.id_proveedor), Number(estacion))
    assert.equal(Number(c.km_al_cargar), 1500)
    const v = (await prueba.q(`SELECT kilometraje FROM flota_vehiculos WHERE id = ?`, [camion])).rows[0]
    assert.equal(Number(v.kilometraje), 1500)
  })

  it('la deuda con la estación queda en cero (la carga suma, el pago resta)', async () => {
    const c = await EstacionesModel.cuenta(estacion)
    assert.equal(c.debe, 90000)
    assert.equal(c.haber, 90000)
    assert.equal(c.saldo, 0)
  })

  it('el listado de Compras muestra los datos y que quedó en el camión', async () => {
    const idx = await llamar(ComprasController, 'index', { user, query: { vehiculo: String(camion), preset: 'rango', fechaDesde: '2026-10-01', fechaHasta: '2026-10-31' } })
    const html = await renderVista(idx.vista, { ...idx.data, scripts: [] })
    assert.match(html, /14:05 · Fact\. 0001-00000077 · Rem\. R-77 · 75,5 l · Chofer: Chofer Prueba/)
    assert.match(html, /Carga en camión/)
    assert.match(html, /También se elimina la carga de combustible del camión/)
  })

  it('en Flota la carga no se elimina sola: remite a Compras / Pagos', async () => {
    const r = await llamar(FlotaController, 'eliminarCombustible', { user, params: { id: camion, cargaId } })
    assert.match(r.flashes[0].msg, /Compras \/ Pagos/)
    const n = (await prueba.q(`SELECT COUNT(*) AS n FROM combustible WHERE id = ?`, [cargaId])).rows[0].n
    assert.equal(Number(n), 1)
    const v = await llamar(FlotaController, 'detalle', { user, params: { id: camion }, query: { tab: 'combustible', mes: '2026-10' } })
    const html = await renderVista(v.vista, { ...v.data, scripts: [] })
    assert.match(html, /Registrada desde Compras \/ Pagos/)
    assert.doesNotMatch(html, new RegExp(`/combustible/${cargaId}/eliminar`))
  })

  it('eliminar el pago en Compras borra también la carga', async () => {
    await llamar(ComprasController, 'eliminar', { user, params: { id: egresoId } })
    const n = (await prueba.q(`SELECT COUNT(*) AS n FROM combustible WHERE id = ?`, [cargaId])).rows[0].n
    assert.equal(Number(n), 0)
    const c = await EstacionesModel.cuenta(estacion)
    assert.equal(c.saldo, 0)
    assert.equal(c.movimientos.length, 0)
  })
})
