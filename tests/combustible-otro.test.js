'use strict'
// Pago de combustible con "Otro" en camión y chofer: una carga a un tercero, ajeno a la
// empresa. El pago se registra con su monto pero sin camión ni chofer de la flota (no hay
// carga en Flota y la cuenta de la estación solo recibe el pago); se marca con
// egresos.carga_tercero para poder mostrar "Otro" al editar, en el listado y en el detalle.
// Corre dentro de la transacción de prueba (ROLLBACK al final: nada queda guardado).
const prueba = require('./helpers/db')
const datos = require('./helpers/datos')
const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { renderVista } = require('./helpers/vistas')
const ComprasController = require('../src/controllers/compras.controller')
const ProveedoresController = require('../src/controllers/proveedores.controller')
const EgresosModel = require('../src/models/egresos.model')
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
  camion = (await prueba.q(`INSERT INTO flota_vehiculos (nombre, patente, tipo_vehiculo, kilometraje) VALUES ('Camión prueba otro', 'ZZ996ZZ', 'camion', 1000) RETURNING id`)).rows[0].id
  await llamar(ProveedoresController, 'crear', { user, body: { nombre: 'Estación Prueba Otro', es_estacion: '1' } })
  estacion = (await prueba.q(`SELECT id FROM proveedores WHERE nombre = 'Estación Prueba Otro'`)).rows[0].id
  chofer = (await datos.crearChofer()).id_empleado
  await prueba.q(`UPDATE empleados SET es_chofer = 1 WHERE id = ?`, [chofer])
})
after(() => prueba.cerrar())

const egreso = async (id) => (await prueba.q(`SELECT * FROM egresos WHERE id = ?`, [id])).rows[0]

describe('columna carga_tercero', () => {
  it('un pago sin la marca queda en 0', async () => {
    const id = await EgresosModel.crear({ categoria: 'combustible', monto: 1000 })
    assert.equal(Number((await egreso(id)).carga_tercero), 0)
  })

  it('crear guarda la marca, sin camión ni chofer', async () => {
    const id = await EgresosModel.crear({ categoria: 'combustible', monto: 1000, carga_tercero: 1 })
    const e = await egreso(id)
    assert.equal(Number(e.carga_tercero), 1)
    assert.equal(e.id_vehiculo, null)
    assert.equal(e.id_chofer, null)
  })

  it('editar cambia la marca', async () => {
    const id = await EgresosModel.crear({ categoria: 'combustible', monto: 1000 })
    await EgresosModel.editar(id, { fecha: '2026-10-25', monto: 1000, carga_tercero: 1 })
    assert.equal(Number((await egreso(id)).carga_tercero), 1)
    await EgresosModel.editar(id, { fecha: '2026-10-25', monto: 1000, carga_tercero: 0 })
    assert.equal(Number((await egreso(id)).carga_tercero), 0)
  })
})

const base = (extra = {}) => ({
  categoria: 'combustible', fecha: '2026-10-25', monto: '90000', metodo_pago: 'transferencia',
  id_vehiculo: String(camion), id_proveedor: String(estacion), id_chofer: String(chofer),
  hora: '14:05', nro_factura: '0001-00000088', nro_remito: 'R-88', litros: '75.5', ...extra,
})
const ultimo = async (categoria = 'combustible') =>
  (await prueba.q(`SELECT * FROM egresos WHERE categoria = ? ORDER BY id DESC LIMIT 1`, [categoria])).rows[0]
const cuenta = async (sql, params = []) => Number((await prueba.q(sql, params)).rows[0].n)
const contarEgresos = () => cuenta(`SELECT COUNT(*) AS n FROM egresos`)
const contarCargas = () => cuenta(`SELECT COUNT(*) AS n FROM combustible`)

// Categoría con el campo 'vehiculo' pero sin 'carga' (se crea una sola vez por corrida)
let claveSinCarga = null
const categoriaSinCarga = async () => {
  if (!claveSinCarga) {
    const id = await CategoriasEgresoModel.crear({ etiqueta: 'Peaje prueba otro', campos: ['vehiculo'] })
    claveSinCarga = (await CategoriasEgresoModel.obtener(id)).clave
  }
  return claveSinCarga
}

describe('alta con "Otro"', () => {
  it('Otro en camión y chofer registra el pago sin camión ni chofer', async () => {
    const cargasAntes = await contarCargas()
    const r = await llamar(ComprasController, 'crear', { user, body: base({ id_vehiculo: 'otro', id_chofer: 'otro', descripcion: 'A tercero 1' }) })
    assert.equal(r.url, '/compras')
    assert.ok(r.flashes.some(f => f.tipo === 'success'), JSON.stringify(r.flashes))
    const e = await ultimo()
    assert.equal(e.descripcion, 'A tercero 1')
    assert.equal(e.id_vehiculo, null)
    assert.equal(e.id_chofer, null)
    assert.equal(Number(e.carga_tercero), 1)
    assert.equal(Number(e.monto), 90000)
    assert.equal(e.id_combustible, null)
    assert.equal(Number(e.litros), 75.5)
    assert.equal(e.nro_factura, '0001-00000088')
    assert.equal(await contarCargas(), cargasAntes)
  })

  it('con Otro, la cuenta de la estación solo recibe el pago', async () => {
    const c = await EstacionesModel.cuenta(estacion)
    assert.equal(c.debe, 0)
    assert.equal(c.haber, 90000)
    assert.equal(c.saldo, -90000)
  })

  it('Otro solo en el chofer también es a tercero', async () => {
    await llamar(ComprasController, 'crear', { user, body: base({ id_chofer: 'otro', descripcion: 'A tercero 2' }) })
    const e = await ultimo()
    assert.equal(e.descripcion, 'A tercero 2')
    assert.equal(e.id_vehiculo, null)
    assert.equal(e.id_chofer, null)
    assert.equal(Number(e.carga_tercero), 1)
  })

  it('Otro solo en el camión también es a tercero (aunque el chofer sea real)', async () => {
    await llamar(ComprasController, 'crear', { user, body: base({ id_vehiculo: 'otro', descripcion: 'A tercero 3' }) })
    const e = await ultimo()
    assert.equal(e.descripcion, 'A tercero 3')
    assert.equal(e.id_vehiculo, null)
    assert.equal(e.id_chofer, null)
    assert.equal(Number(e.carga_tercero), 1)
  })

  it('Otro con "Impacta" se rechaza y no guarda nada', async () => {
    const egresosAntes = await contarEgresos()
    const cargasAntes = await contarCargas()
    const r = await llamar(ComprasController, 'crear', { user, body: base({ id_vehiculo: 'otro', id_chofer: 'otro', impacta_flota: '1', km_al_cargar: '100' }) })
    assert.equal(r.url, '/compras/nueva')
    assert.match(r.flashes[0].msg, /Otro/)
    assert.match(r.flashes[0].msg, /Impacta en autonomía del camión/)
    assert.equal(await contarEgresos(), egresosAntes)
    assert.equal(await contarCargas(), cargasAntes)
  })

  it('un pago con camión y chofer reales sigue igual', async () => {
    await llamar(ComprasController, 'crear', { user, body: base({ descripcion: 'Con camión real' }) })
    const e = await ultimo()
    assert.equal(e.descripcion, 'Con camión real')
    assert.equal(Number(e.id_vehiculo), Number(camion))
    assert.equal(Number(e.id_chofer), Number(chofer))
    assert.equal(Number(e.carga_tercero), 0)
  })

  it('en una categoría sin carga, "otro" se ignora', async () => {
    const clave = await categoriaSinCarga()
    const r = await llamar(ComprasController, 'crear', { user, body: { categoria: clave, fecha: '2026-10-25', monto: '5000', metodo_pago: 'efectivo', id_vehiculo: 'otro' } })
    assert.equal(r.url, '/compras')
    assert.ok(r.flashes.some(f => f.tipo === 'success'), JSON.stringify(r.flashes))
    const e = await ultimo(clave)
    assert.equal(e.id_vehiculo, null)
    assert.equal(Number(e.carga_tercero), 0)
  })
})

describe('edición con "Otro"', () => {
  const alta = async (extra = {}) => {
    const r = await llamar(ComprasController, 'crear', { user, body: base(extra) })
    assert.equal(r.url, '/compras', JSON.stringify(r.flashes))
    return (await ultimo()).id
  }
  const actualizar = (id, body) => llamar(ComprasController, 'actualizar', { user, params: { id }, body })

  it('pasar un pago con carga en Flota a Otro borra la carga', async () => {
    const id = await alta({ impacta_flota: '1', km_al_cargar: '1500', descripcion: 'Edición 1' })
    const antes = await egreso(id)
    assert.ok(antes.id_combustible, 'el alta con Impacta crea la carga')
    const r = await actualizar(id, base({ id_vehiculo: 'otro', id_chofer: 'otro', descripcion: 'Edición 1' }))
    assert.equal(r.url, '/compras')
    const e = await egreso(id)
    assert.equal(e.id_vehiculo, null)
    assert.equal(e.id_chofer, null)
    assert.equal(Number(e.carga_tercero), 1)
    assert.equal(e.id_combustible, null)
    assert.equal(await cuenta(`SELECT COUNT(*) AS n FROM combustible WHERE id = ?`, [antes.id_combustible]), 0)
  })

  it('Otro con "Impacta" se rechaza al editar y el pago no cambia', async () => {
    const id = await alta({ descripcion: 'Edición 2' })
    const r = await actualizar(id, base({ id_vehiculo: 'otro', id_chofer: 'otro', impacta_flota: '1', descripcion: 'Edición 2' }))
    assert.equal(r.url, `/compras/${id}/editar`)
    assert.match(r.flashes[0].msg, /Otro/)
    const e = await egreso(id)
    assert.equal(Number(e.id_vehiculo), Number(camion))
    assert.equal(Number(e.carga_tercero), 0)
  })

  it('volver de Otro a camión y chofer reales limpia la marca', async () => {
    const id = await alta({ id_vehiculo: 'otro', id_chofer: 'otro', descripcion: 'Edición 3' })
    assert.equal(Number((await egreso(id)).carga_tercero), 1)
    await actualizar(id, base({ descripcion: 'Edición 3' }))
    const e = await egreso(id)
    assert.equal(Number(e.carga_tercero), 0)
    assert.equal(Number(e.id_vehiculo), Number(camion))
    assert.equal(Number(e.id_chofer), Number(chofer))
  })

  it('en una categoría sin carga, "otro" se ignora al editar', async () => {
    const clave = await categoriaSinCarga()
    await llamar(ComprasController, 'crear', { user, body: { categoria: clave, fecha: '2026-10-25', monto: '5000', metodo_pago: 'efectivo', id_vehiculo: String(camion) } })
    const id = (await ultimo(clave)).id
    const r = await actualizar(id, { fecha: '2026-10-25', monto: '6000', metodo_pago: 'efectivo', id_vehiculo: 'otro' })
    assert.equal(r.url, '/compras')
    const e = await egreso(id)
    assert.equal(e.id_vehiculo, null)
    assert.equal(Number(e.carga_tercero), 0)
    assert.equal(Number(e.monto), 6000)
  })
})

describe('pantallas', () => {
  const html = async (r) => renderVista(r.vista, { ...r.data, scripts: [] })
  // La opción "otro" tiene que estar DENTRO de cada select (sin cruzar el </select>)
  const opcionOtroEn = {
    selVehiculo: /<select name="id_vehiculo" id="selVehiculo"[^>]*>(?:(?!<\/select>)[\s\S])*<option value="otro"[^>]*>Otro<\/option>/,
    selChofer: /<select name="id_chofer" id="selChofer"[^>]*>(?:(?!<\/select>)[\s\S])*<option value="otro"[^>]*>Otro<\/option>/,
  }
  const otroElegido = /<option value="otro"[^>]*selected[^>]*>Otro<\/option>/g

  it('el formulario ofrece Otro en camión y chofer', async () => {
    const h = await html(await llamar(ComprasController, 'nueva', { user }))
    assert.match(h, opcionOtroEn.selVehiculo)
    assert.match(h, opcionOtroEn.selChofer)
    assert.match(h, /<select name="id_chofer" id="selChofer" class="form-select" required>/)
    assert.equal((h.match(otroElegido) || []).length, 0)
    // El aviso arranca oculto: .d-block (con !important) pisaría su display:none
    assert.match(h, /id="avisoOtro" class="[^"]*" style="display:none"/)
    assert.doesNotMatch(h, /id="avisoOtro" class="[^"]*d-block/)
  })

  let idTercero
  it('al editar un pago a tercero, Otro viene elegido en los dos', async () => {
    await llamar(ComprasController, 'crear', { user, body: base({ id_vehiculo: 'otro', id_chofer: 'otro', descripcion: 'Pantalla tercero', fecha: '2026-10-26' }) })
    idTercero = (await ultimo()).id
    const h = await html(await llamar(ComprasController, 'editar', { user, params: { id: idTercero } }))
    assert.equal((h.match(otroElegido) || []).length, 2)
  })

  it('un pago viejo sin chofer no aparece como Otro', async () => {
    const id = await EgresosModel.crear({ categoria: 'combustible', monto: 1000, id_vehiculo: camion })
    const h = await html(await llamar(ComprasController, 'editar', { user, params: { id } }))
    assert.equal((h.match(otroElegido) || []).length, 0)
    assert.match(h, opcionOtroEn.selChofer)
  })

  it('el listado y el detalle muestran Otro', async () => {
    const idx = await llamar(ComprasController, 'index', { user, query: { preset: 'rango', fechaDesde: '2026-10-26', fechaHasta: '2026-10-26' } })
    const h = await html(idx)
    assert.match(h, /Camión y chofer: Otro/)
    assert.ok(h.includes('&#34;Vehículo&#34;,&#34;Otro&#34;'), 'el detalle debe decir Vehículo: Otro')
    assert.ok(h.includes('&#34;Chofer&#34;,&#34;Otro&#34;'), 'el detalle debe decir Chofer: Otro')
  })

  it('un pago con camión y chofer reales no dice Otro', async () => {
    await llamar(ComprasController, 'crear', { user, body: base({ descripcion: 'Pantalla real', fecha: '2026-10-27' }) })
    const idx = await llamar(ComprasController, 'index', { user, query: { preset: 'rango', fechaDesde: '2026-10-27', fechaHasta: '2026-10-27' } })
    const h = await html(idx)
    assert.doesNotMatch(h, /Camión y chofer: Otro/)
    assert.ok(!h.includes('&#34;Chofer&#34;,&#34;Otro&#34;'))
  })
})
