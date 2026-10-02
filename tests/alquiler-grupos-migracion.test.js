'use strict'
const prueba = require('./helpers/db')
const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { migrarGruposAlquiler } = require('../src/config/db')

describe('migración: alquileres agrupados', () => {
  before(prueba.abrir)
  after(prueba.cerrar)

  it('crea alquiler_grupos y op_encabezado.id_grupo, y se puede correr dos veces', async () => {
    await migrarGruposAlquiler()
    await migrarGruposAlquiler()
    const cols = (await prueba.q(`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE (table_name = 'alquiler_grupos' AND column_name IN ('id', 'cobro_modo', 'created_at'))
         OR (table_name = 'op_encabezado' AND column_name = 'id_grupo')`)).rows
    assert.equal(cols.length, 4)
  })

  it('cobro_modo solo acepta contenedor o alquiler, y created_at queda en hora local', async () => {
    await assert.rejects(prueba.q(`INSERT INTO alquiler_grupos (cobro_modo) VALUES ('otro')`))
    const r = (await prueba.q(`INSERT INTO alquiler_grupos (cobro_modo) VALUES ('alquiler') RETURNING id, created_at`)).rows[0]
    assert.ok(r.id)
    assert.match(r.created_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  })
})
