'use strict'
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { nombreObra, claveObra, agruparObras, movimientoDeObra } = require('../src/utils/obras')

describe('nombreObra', () => {
  it('si tiene obra, manda la obra aunque también tenga dirección', () => {
    assert.equal(nombreObra({ obra: 'Abras de Manantiales M18 L9', domicilio_calle: 'Colón', domicilio_altura: 1200 }), 'Abras de Manantiales M18 L9')
  })
  it('sin obra, usa calle + número de la venta', () => {
    assert.equal(nombreObra({ obra: '  ', domicilio_calle: 'Colón', domicilio_altura: 1200 }), 'Colón 1200')
  })
  it('sin obra ni dirección en la cabecera, usa la del contenedor y después la de la máquina', () => {
    assert.equal(nombreObra({ cont_calle: 'San Martín', cont_numero: '55' }), 'San Martín 55')
    assert.equal(nombreObra({ cont_entrega: 'Ruta 20 km 3' }), 'Ruta 20 km 3')
    assert.equal(nombreObra({ maq_calle: 'Vélez', maq_numero: '10' }), 'Vélez 10')
  })
  it('ignora el prefijo "Obra" con el que a veces se carga', () => {
    assert.equal(nombreObra({ obra: 'OBRA PRADOS DE MANANTIALES M26 L19' }), 'PRADOS DE MANANTIALES M26 L19')
    assert.equal(nombreObra({ obra: 'Obra: Colón 100' }), 'Colón 100')
    assert.equal(nombreObra({ obra: 'Obrador Norte' }), 'Obrador Norte')
  })
  it('sin ningún dato devuelve vacío', () => {
    assert.equal(nombreObra({}), '')
  })
})

describe('agruparObras', () => {
  it('agrupa la misma obra con otras mayúsculas, acentos o espacios', () => {
    const obras = agruparObras([
      { id: 3, obra: 'Quebradas de Manantiales  M78 L6' },
      { id: 2, obra: 'QUEBRADAS DE MANANTIALES M78 L6' },
      { id: 1, domicilio_calle: 'Colón', domicilio_altura: 1200 },
      { id: 4 },
    ])
    assert.deepEqual(obras.map(o => [o.nombre, o.opIds]), [
      ['Colón 1200', ['1']],
      ['Quebradas de Manantiales M78 L6', ['3', '2']],
    ])
    assert.equal(claveObra('Colón 1200'), 'colon 1200')
  })
})

describe('movimientoDeObra', () => {
  const ops = new Set(['10'])
  it('incluye los cargos de las operaciones de la obra y excluye los de otras', () => {
    assert.equal(movimientoDeObra({ tipo: 'deuda', monto: -100, id_op_encabezado: 10 }, ops), true)
    assert.equal(movimientoDeObra({ tipo: 'deuda', monto: -100, id_op_encabezado: 11 }, ops), false)
  })
  it('incluye todos los pagos y los créditos sin operación; no los cargos manuales', () => {
    assert.equal(movimientoDeObra({ tipo: 'pago', monto: 500, id_op_encabezado: null }, ops), true)
    assert.equal(movimientoDeObra({ tipo: 'pago', monto: 500, id_op_encabezado: 11 }, ops), true)
    assert.equal(movimientoDeObra({ tipo: 'ajuste', monto: 50, id_op_encabezado: null }, ops), true)
    assert.equal(movimientoDeObra({ tipo: 'deuda', monto: -50, id_op_encabezado: null }, ops), false)
  })
})
