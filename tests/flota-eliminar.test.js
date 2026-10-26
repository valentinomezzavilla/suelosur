'use strict'
// Eliminar camiones de la flota: solo los que no tienen actividad; con historial se informa
// qué tiene y se sugiere la baja. Corre dentro de la transacción de prueba (ROLLBACK al final).
const prueba = require('./helpers/db')
const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const ejs = require('ejs')
const path = require('path')
const FlotaModel = require('../src/models/flota.model')
const FlotaController = require('../src/controllers/flota.controller')
const { icon } = require('../src/config/icons')
const { fmtFecha, hoyISO } = require('../src/utils/fecha')

const camion = (patente) => FlotaModel.crear({ patente, nombre: 'Camión ' + patente, tipo_unidad: 'Volcador', actividad: 'ventas' })
const existe = async (id) => (await prueba.q(`SELECT 1 FROM flota_vehiculos WHERE id = ?`, [id])).rowCount === 1

function llamar(accion, { params = {}, query = {}, body = {} } = {}) {
  return new Promise((resolve, reject) => {
    const flashes = []
    const req = { body, params, query, session: { user: { id: null } }, flash: (t, m) => flashes.push({ t, m }) }
    const res = { redirect: (url) => resolve({ url, flashes }), render: (vista, data) => resolve({ vista, data, flashes }) }
    Promise.resolve(FlotaController[accion](req, res)).catch(reject)
  })
}

describe('eliminar camiones de la flota', () => {
  before(() => prueba.abrir())
  after(() => prueba.cerrar())

  it('un camión sin actividad se elimina junto con sus datos propios', async () => {
    const id = await camion('DEL001')
    await prueba.q(`INSERT INTO documentos (entidad_tipo, entidad_id, tipo, archivo) VALUES ('vehiculo', ?, 'seguro', 'seguro-prueba.pdf')`, [id])
    await prueba.q(`INSERT INTO config_mantenimiento (id_vehiculo, tipo) VALUES (?, 'aceite')`, [id])
    const chofer = (await prueba.q(`INSERT INTO empleados (nombre, apellido, activo) VALUES ('Chofer', 'Prueba', 1) RETURNING id`)).rows[0].id
    await prueba.q(`INSERT INTO asignaciones_recurso (id_empleado, recurso_tipo, recurso_id, activo) VALUES (?, 'camion', ?, 1)`, [chofer, id])
    const { archivos } = await FlotaModel.eliminar(id)
    assert.deepEqual(archivos, ['seguro-prueba.pdf'])
    assert.equal(await existe(id), false)
    for (const [tabla, col] of [['estado_vehiculo_hist', 'id_vehiculo'], ['config_mantenimiento', 'id_vehiculo']]) {
      assert.equal((await prueba.q(`SELECT 1 FROM ${tabla} WHERE ${col} = ?`, [id])).rowCount, 0, tabla)
    }
    assert.equal((await prueba.q(`SELECT 1 FROM documentos WHERE entidad_tipo = 'vehiculo' AND entidad_id = ?`, [id])).rowCount, 0)
    assert.equal((await prueba.q(`SELECT 1 FROM asignaciones_recurso WHERE recurso_tipo = 'camion' AND recurso_id = ?`, [id])).rowCount, 0)
  })

  it('no toca a los otros camiones', async () => {
    const a = await camion('DEL002'), b = await camion('DEL003')
    await FlotaModel.eliminar(a)
    assert.equal(await existe(b), true)
    assert.equal((await prueba.q(`SELECT 1 FROM estado_vehiculo_hist WHERE id_vehiculo = ?`, [b])).rowCount, 1)
  })

  it('con gastos o compras cargadas no se elimina: dice qué tiene y sugiere la baja', async () => {
    const id = await camion('DEL004')
    await prueba.q(`INSERT INTO egresos (categoria, monto, id_vehiculo) VALUES ('seguro', 1000, ?)`, [id])
    await prueba.q(`INSERT INTO gastos_vehiculo (id_vehiculo, categoria, monto) VALUES (?, 'seguro', 500)`, [id])
    await assert.rejects(() => FlotaModel.eliminar(id), /No se puede eliminar el camión: tiene 1 gastos, 1 compras \/ pagos\. Para conservar el historial, dalo de baja\./)
    assert.equal(await existe(id), true)
    assert.equal((await prueba.q(`SELECT 1 FROM estado_vehiculo_hist WHERE id_vehiculo = ?`, [id])).rowCount, 1)
  })

  it('con operaciones tampoco', async () => {
    const id = await camion('DEL005')
    await prueba.q(`INSERT INTO circuitos (id_camion) VALUES (?)`, [id])
    await assert.rejects(() => FlotaModel.eliminar(id), /tiene 1 circuitos\./)
    assert.equal(await existe(id), true)
  })

  it('un id inexistente da un error claro', async () => {
    await assert.rejects(() => FlotaModel.eliminar(999999999), /Camión no encontrado/)
  })

  it('el controlador vuelve a la flota al eliminar y al detalle si no se puede', async () => {
    const libre = await camion('DEL006')
    const ok = await llamar('eliminar', { params: { id: libre } })
    assert.equal(ok.url, '/flota')
    assert.match(ok.flashes[0].m, /eliminado de la flota/)
    assert.equal(await existe(libre), false)

    const usado = await camion('DEL007')
    await prueba.q(`INSERT INTO egresos (categoria, monto, id_vehiculo) VALUES ('seguro', 1, ?)`, [usado])
    const no = await llamar('eliminar', { params: { id: usado } })
    assert.equal(no.url, `/flota/${usado}`)
    assert.equal(no.flashes[0].t, 'error')
    assert.equal(await existe(usado), true)
  })

  it('el listado y el detalle muestran el botón de eliminar (y de baja en el detalle)', async () => {
    const id = await camion('DEL008')
    const locals = { icon, formatFecha: fmtFecha, hoyISO }
    const lista = await llamar('index', {})
    const htmlLista = await ejs.renderFile(path.join(__dirname, '..', 'views/pages/flota/index.ejs'), { ...lista.data, ...locals })
    assert.ok(htmlLista.includes(`action="/flota/${id}/eliminar"`))
    const det = await llamar('detalle', { params: { id } })
    const htmlDet = await ejs.renderFile(path.join(__dirname, '..', 'views/pages/flota/detalle.ejs'), { ...det.data, ...locals })
    assert.ok(htmlDet.includes(`action="/flota/${id}/eliminar"`))
    assert.ok(htmlDet.includes(`action="/flota/${id}/toggle"`) && htmlDet.includes('Dar de baja'))
  })
})
