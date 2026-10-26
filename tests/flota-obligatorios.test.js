'use strict'
// Alta de camiones: patente, nombre, tipo de unidad y actividad son obligatorios.
// Corre dentro de la transacción de prueba (ROLLBACK al final: nada queda guardado).
const prueba = require('./helpers/db')
const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const ejs = require('ejs')
const path = require('path')
const FlotaModel = require('../src/models/flota.model')
const FlotaController = require('../src/controllers/flota.controller')
const { icon } = require('../src/config/icons')

const completo = { patente: 'ZZ999ZZ', nombre: 'Camión prueba', tipo_unidad: 'Volcador', actividad: 'ventas' }

describe('campos obligatorios al cargar un camión', () => {
  before(() => prueba.abrir())
  after(() => prueba.cerrar())

  it('faltantes lista las etiquetas de lo que está vacío (espacios cuentan como vacío)', () => {
    assert.deepEqual(FlotaModel.faltantes(completo), [])
    assert.deepEqual(FlotaModel.faltantes({ ...completo, patente: '   ', actividad: '' }), ['Patente', 'Actividad del camión'])
    assert.equal(FlotaModel.faltantes({}).length, 4)
  })

  it('crear con datos incompletos no guarda nada y dice qué falta', async () => {
    const antes = (await prueba.q(`SELECT COUNT(*) AS n FROM flota_vehiculos`)).rows[0].n
    await assert.rejects(() => FlotaModel.crear({ ...completo, tipo_unidad: '', nombre: '' }),
      /Completá los datos obligatorios: Nombre \/ Identificación, Tipo de unidad\./)
    assert.equal((await prueba.q(`SELECT COUNT(*) AS n FROM flota_vehiculos`)).rows[0].n, antes)
  })

  it('crear con todo completo guarda el camión', async () => {
    const id = await FlotaModel.crear(completo)
    const v = await FlotaModel.obtener(id)
    assert.equal(v.patente, 'ZZ999ZZ')
    assert.equal(v.actividad, 'ventas')
  })

  it('el controlador vuelve al formulario con el aviso cuando falta algo', async () => {
    const r = await new Promise((resolve, reject) => {
      const flashes = []
      const req = { body: { ...completo, patente: '' }, params: {}, session: { user: { id: 1 } }, flash: (t, m) => flashes.push({ t, m }) }
      FlotaController.crear(req, { redirect: (url) => resolve({ url, flashes }) }).catch(reject)
    })
    assert.equal(r.url, '/flota/nuevo')
    assert.match(r.flashes[0].m, /Patente/)
  })

  const render = (extra) => ejs.renderFile(path.join(__dirname, '..', 'views/pages/flota/form.ejs'),
    { titulo: 'x', icon, estados: FlotaModel.ESTADOS, dedicaciones: FlotaModel.DEDICACIONES, ...extra })

  it('el formulario de alta marca con * y exige los cuatro campos', async () => {
    const html = await render({ vehiculo: null, obligatorios: FlotaModel.OBLIGATORIOS })
    for (const etiqueta of Object.values(FlotaModel.OBLIGATORIOS)) assert.ok(html.includes(`${etiqueta} *</label>`), etiqueta)
    assert.equal((html.match(/ required /g) || []).length, 4)
    assert.match(html, /Los campos marcados con \* son obligatorios/)
    assert.doesNotMatch(html, /N° interno \*|Marca \*/)
  })

  it('el formulario de edición no pide nada nuevo (los camiones viejos siguen guardándose)', async () => {
    const html = await render({ vehiculo: { id: 1, patente: 'AA111AA' }, obligatorios: {} })
    assert.doesNotMatch(html, / \*<\/label>| required /)
  })
})
