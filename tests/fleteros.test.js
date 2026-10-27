'use strict'
// Fleteros: ABM como el de proveedores. Las compras guardan el nombre del fletero
// (egresos.fletero): uno escrito en una compra se da de alta solo, sin duplicar por
// mayúsculas, y renombrarlo actualiza sus compras.
// Corre dentro de la transacción de prueba (ROLLBACK al final: nada queda guardado).
const prueba = require('./helpers/db')
const datos = require('./helpers/datos')
const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const ComprasController = require('../src/controllers/compras.controller')
const FleterosController = require('../src/controllers/fleteros.controller')
const FleterosModel = require('../src/models/fleteros.model')
const TerceroService = require('../src/services/tercero.service')

function llamar(ctrl, accion, { body = {}, params = {}, query = {}, user }) {
  return new Promise((resolve, reject) => {
    const flashes = []
    const req = { body, params, query, session: { user }, flash: (tipo, msg) => flashes.push({ tipo, msg }) }
    const res = { locals: {}, redirect: (url) => resolve({ url, flashes, locals: res.locals }),
                  render: (vista, data) => resolve({ vista, data, flashes, locals: res.locals }) }
    Promise.resolve(ctrl[accion](req, res)).catch(reject)
  })
}

describe('fleteros', () => {
  let user, arena

  before(async () => {
    await prueba.abrir()
    user = { id: await datos.idAdministrativo(), rol: 'dueno' }
    arena = (await prueba.q(`INSERT INTO productos (nombre, unidad_medida, activo) VALUES ('Arena prueba fleteros', 'tn', 1) RETURNING id`)).rows[0].id
    await prueba.q(`INSERT INTO stock (id_producto, cantidad_actual) VALUES (?, 0) ON CONFLICT DO NOTHING`, [arena])
  })
  after(() => prueba.cerrar())

  const porNombre = async (nombre) => (await prueba.q(`SELECT * FROM fleteros WHERE LOWER(nombre) = LOWER(?)`, [nombre])).rows
  const comprar = (fletero) => llamar(ComprasController, 'crear', { user, body: {
    categoria: 'material', fecha: '2026-10-10', metodo_pago: 'efectivo',
    id_producto: arena, cantidad: '10', costo_unitario: '1000', costo_flete: '50', fletero,
  } })

  it('alta desde la pantalla de Fleteros, sin repetir nombres', async () => {
    const r = await llamar(FleterosController, 'crear', { user, body: { nombre: '  Fletes Prueba Uno ', telefono: '351-555' } })
    assert.equal(r.url, '/fleteros')
    const [f] = await porNombre('Fletes Prueba Uno')
    assert.equal(f.nombre, 'Fletes Prueba Uno')
    assert.equal(f.telefono, '351-555')

    const dup = await llamar(FleterosController, 'crear', { user, body: { nombre: 'FLETES PRUEBA UNO' } })
    assert.equal(dup.vista, 'pages/fleteros/form')
    assert.match(dup.locals.error[0], /Ya existe/)
    assert.equal(dup.data.valores.nombre, 'FLETES PRUEBA UNO')
    assert.equal((await porNombre('Fletes Prueba Uno')).length, 1)

    const vacio = await llamar(FleterosController, 'crear', { user, body: { nombre: '  ' } })
    assert.match(vacio.locals.error[0], /obligatorio/)
  })

  it('un fletero nuevo escrito en una compra se da de alta; con otras mayúsculas usa el existente', async () => {
    await comprar('  Transportes Prueba Sur ')
    assert.equal((await porNombre('Transportes Prueba Sur')).length, 1)
    await comprar('TRANSPORTES PRUEBA SUR')
    assert.equal((await porNombre('Transportes Prueba Sur')).length, 1)
    const { rows } = await prueba.q(`SELECT fletero FROM egresos WHERE LOWER(fletero) = 'transportes prueba sur'`)
    assert.deepEqual(rows.map(r => r.fletero), ['Transportes Prueba Sur', 'Transportes Prueba Sur'])
  })

  it('el listado cuenta las compras y suma el flete pagado', async () => {
    const [f] = (await FleterosModel.listarTodos({ q: 'transportes prueba sur' }))
    assert.equal(Number(f.compras), 2)
    assert.equal(Number(f.total_flete), 1000)   // 2 compras × 10 × $50
  })

  it('renombrar un fletero actualiza sus compras; no puede tomar el nombre de otro', async () => {
    const [f] = await porNombre('Transportes Prueba Sur')
    const choca = await llamar(FleterosController, 'actualizar', { user, params: { id: f.id }, body: { nombre: 'fletes prueba uno' } })
    assert.equal(choca.vista, 'pages/fleteros/form')
    assert.match(choca.locals.error[0], /Ya existe otro/)

    const r = await llamar(FleterosController, 'actualizar', { user, params: { id: f.id }, body: { nombre: 'Transportes Prueba Norte', cuit: '20-1-2' } })
    assert.equal(r.url, '/fleteros')
    const { rows } = await prueba.q(`SELECT fletero FROM egresos WHERE fletero LIKE 'Transportes Prueba%'`)
    assert.deepEqual(rows.map(x => x.fletero), ['Transportes Prueba Norte', 'Transportes Prueba Norte'])
    assert.equal((await FleterosModel.obtener(f.id)).cuit, '20-1-2')
  })

  it('desactivado no aparece entre las sugerencias, pero una compra con su nombre no lo duplica', async () => {
    const [f] = await porNombre('Fletes Prueba Uno')
    await llamar(FleterosController, 'toggleActivo', { user, params: { id: f.id } })
    assert.ok(!(await FleterosModel.listar()).some(x => x.id === f.id))
    await comprar('fletes prueba uno')
    assert.equal((await porNombre('Fletes Prueba Uno')).length, 1)
  })

  it('transferencia a tercero con fletero: lo da de alta y lo ofrece en las opciones', async () => {
    await TerceroService.crearEgreso({ categoria: 'otro', fletero: 'Camiones Prueba Tercero', concepto: 'flete' }, { monto: 500, id_usuario: user.id })
    assert.equal((await porNombre('Camiones Prueba Tercero')).length, 1)
    assert.ok((await TerceroService.opciones()).fleteros.includes('Camiones Prueba Tercero'))
  })
})
