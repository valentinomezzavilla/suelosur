'use strict'
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const qs = require('qs') // el mismo parser que usa express.urlencoded({ extended: true })
const { leerContenedoresDelForm, leerMontosPorOp } = require('../src/utils/contenedoresForm')

describe('leerContenedoresDelForm', () => {
  it('sin selección devuelve una lista vacía', () => {
    assert.deepEqual(leerContenedoresDelForm({}), { contenedores: [] })
  })

  it('un solo id (string) se lee como un contenedor', () => {
    assert.deepEqual(leerContenedoresDelForm({ ids_contenedor: '7' }),
      { contenedores: [{ id_contenedor: '7', fin: '' }] })
  })

  it('con ids chicos, la fecha de fin propia sigue asociada a su contenedor', () => {
    // Con claves numéricas qs armaría un array y perdería el contenedor: por eso el prefijo "c".
    const body = qs.parse('ids_contenedor[]=3&ids_contenedor[]=5&fin_c[c3]=2026-10-20')
    assert.deepEqual(leerContenedoresDelForm(body), {
      contenedores: [
        { id_contenedor: '3', fin: '2026-10-20' },
        { id_contenedor: '5', fin: '' },
      ],
    })
  })

  it('el alta no lee precios: un precio_c que venga de un formulario viejo se ignora', () => {
    const body = qs.parse('ids_contenedor[]=3&ids_contenedor[]=5&precio_c[c5]=150')
    assert.deepEqual(leerContenedoresDelForm(body), {
      contenedores: [{ id_contenedor: '3', fin: '' }, { id_contenedor: '5', fin: '' }],
    })
  })

  it('un contenedor repetido es un error', () => {
    assert.deepEqual(leerContenedoresDelForm({ ids_contenedor: ['4', '4'] }),
      { error: 'Elegiste el mismo contenedor más de una vez.' })
  })
})

describe('leerMontosPorOp', () => {
  it('deja igual un monto suelto o vacío', () => {
    assert.equal(leerMontosPorOp('1500'), '1500')
    assert.equal(leerMontosPorOp(undefined), undefined)
  })

  it('convierte { op<ID>: monto } en { <ID>: monto }, también con ids chicos', () => {
    const body = qs.parse('precio_final[op3]=100&precio_final[op12]=250')
    assert.deepEqual(leerMontosPorOp(body.precio_final), { 3: '100', 12: '250' })
  })
})
