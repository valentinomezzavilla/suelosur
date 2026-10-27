'use strict'
// Script que vincula a una estación de servicio las transferencias, pagos y cargas que se
// cargaron con el nombre escrito a mano. Corre dentro de la transacción de prueba (ROLLBACK).
const prueba = require('./helpers/db')
const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const EstacionesModel = require('../src/models/estaciones.model')
const { vincular } = require('../scripts/vincular-estacion')

describe('vincular transferencias a una estación', () => {
  let camion, comun, ids

  before(async () => {
    await prueba.abrir()
    camion = (await prueba.q(`INSERT INTO flota_vehiculos (nombre, patente, tipo_vehiculo) VALUES ('Camión prueba vincular', 'ZZ998ZZ', 'camion') RETURNING id`)).rows[0].id
    comun = (await prueba.q(`INSERT INTO proveedores (nombre) VALUES ('Corralón Prueba Vincular') RETURNING id`)).rows[0].id
    const egreso = async (descripcion, monto, origen, extra = {}) => (await prueba.q(`
      INSERT INTO egresos (fecha, categoria, descripcion, monto, metodo_pago, origen, id_proveedor)
      VALUES ('2026-10-14', ?, ?, ?, 'transferencia', ?, ?) RETURNING id`,
      [extra.categoria || 'combustible', descripcion, monto, origen, extra.id_proveedor || null])).rows[0].id
    ids = {
      t1: await egreso('ZETAOIL — Transferencia de Daniel Desagotes a tercero (VIA 1)', 182000, 'tercero'),
      t2: await egreso('zetaoil — Transferencia de Daniel Desagotes a tercero (VIA 2)', 336000, 'tercero'),
      pago: await egreso('Pago ZetaOil factura 1', 50000, 'manual'),
      otraCat: await egreso('ZETAOIL lavado', 1000, 'manual', { categoria: 'mantenimiento' }),
      yaVinculado: await egreso('ZETAOIL a otro', 2000, 'manual', { id_proveedor: comun }),
      otraEstacion: await egreso('YPF — Transferencia', 3000, 'tercero'),
      carga: (await prueba.q(`INSERT INTO combustible (id_vehiculo, litros, costo_total, fecha, estacion) VALUES (?, 100, 600000, '2026-10-10', 'ZetaOil centro') RETURNING id`, [camion])).rows[0].id,
    }
  })
  after(prueba.cerrar)

  const proveedorDe = async (id) => (await prueba.q(`SELECT id_proveedor FROM egresos WHERE id = ?`, [id])).rows[0].id_proveedor

  it('sin --aplicar no guarda nada pero muestra lo que haría', async () => {
    const r = await vincular({ estacion: 'ZetaOil' })
    assert.equal(r.aplicado, false)
    assert.equal(r.nuevo, true)
    assert.deepEqual(r.egresos.map(e => Number(e.id)), [ids.t1, ids.t2, ids.pago].map(Number))
    assert.deepEqual(r.cargas.map(c => Number(c.id)), [Number(ids.carga)])
    assert.equal(r.despues.saldo, 600000 - 182000 - 336000 - 50000)
    assert.equal(await proveedorDe(ids.t1), null)
    assert.equal((await prueba.q(`SELECT 1 FROM proveedores WHERE nombre = 'ZetaOil'`)).rows.length, 0)
  })

  it('con --aplicar da de alta la estación y vincula solo lo que corresponde', async () => {
    const r = await vincular({ estacion: 'ZetaOil', aplicar: true })
    const id = r.proveedor.id
    assert.ok((await EstacionesModel.obtener(id)), 'quedó marcada como estación')
    for (const k of ['t1', 't2', 'pago']) assert.equal(Number(await proveedorDe(ids[k])), Number(id), k)
    assert.equal(await proveedorDe(ids.otraCat), null)
    assert.equal(await proveedorDe(ids.otraEstacion), null)
    assert.equal(Number(await proveedorDe(ids.yaVinculado)), Number(comun))
    const cuenta = await EstacionesModel.cuenta(id)
    assert.equal(cuenta.saldo, 600000 - 182000 - 336000 - 50000)
    assert.equal(cuenta.movimientos.filter(m => m.origen === 'transferencia').length, 2)
  })

  it('correrlo de nuevo no duplica ni cambia nada', async () => {
    const r = await vincular({ estacion: 'zetaoil', aplicar: true })
    assert.equal(r.nuevo, false)
    assert.equal(r.egresos.length, 0)
    assert.equal(r.cargas.length, 0)
    assert.equal(r.antes.saldo, r.despues.saldo)
  })

  it('usa un proveedor existente y lo marca como estación', async () => {
    const p = (await prueba.q(`INSERT INTO proveedores (nombre) VALUES ('Puma Prueba Vincular') RETURNING id`)).rows[0].id
    const e = (await prueba.q(`INSERT INTO egresos (fecha, categoria, descripcion, monto, origen) VALUES ('2026-10-15', 'combustible', 'PUMA PRUEBA — transf', 7000, 'tercero') RETURNING id`)).rows[0].id
    const r = await vincular({ estacion: 'Puma', texto: 'puma prueba', aplicar: true, conCargas: false })
    assert.equal(Number(r.proveedor.id), Number(p))
    assert.equal(r.marcada, true)
    assert.equal(Number(await proveedorDe(e)), Number(p))
  })
})
