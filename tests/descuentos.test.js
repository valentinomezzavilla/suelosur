'use strict'
// Descuentos: lógica pura (validar, qué se puede descontar, reparto). Sin base.
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const D = require('../src/utils/descuentos')

const op = (extra = {}) => ({
  id: 1, estado: 'pendiente', estadoOp: 'entregado', metodo_pago: 'efectivo', resta: 1000,
  aConvenir: false, estimado: false, enCurso: false, grupoTodoJunto: false, enCuenta: false, ...extra,
})

describe('descuentos: validar', () => {
  it('acepta porcentaje y monto válidos', () => {
    assert.deepEqual(D.validar({ tipo: 'porcentaje', valor: '10', alcance: 'todas' }),
      { tipo: 'porcentaje', valor: 10, alcance: 'todas', referencia: null })
    assert.deepEqual(D.validar({ tipo: 'monto', valor: '250000,50', alcance: 'remito', referencia: ' 456 ' }),
      { tipo: 'monto', valor: 250000.5, alcance: 'remito', referencia: '456' })
  })
  it('rechaza valores fuera de rango, tipos y alcances desconocidos', () => {
    assert.ok(D.validar({ tipo: 'porcentaje', valor: 0, alcance: 'todas' }).error)
    assert.ok(D.validar({ tipo: 'porcentaje', valor: 101, alcance: 'todas' }).error)
    assert.ok(D.validar({ tipo: 'monto', valor: -5, alcance: 'todas' }).error)
    assert.ok(D.validar({ tipo: 'otro', valor: 5, alcance: 'todas' }).error)
    assert.ok(D.validar({ tipo: 'monto', valor: 5, alcance: 'cualquiera' }).error)
  })
  it('remito, factura y operación piden a cuál', () => {
    for (const alcance of ['remito', 'factura', 'operacion']) {
      assert.ok(D.validar({ tipo: 'monto', valor: 5, alcance }).error, alcance)
    }
  })
})

describe('descuentos: qué operaciones se pueden descontar', () => {
  it('una entregada de contado que debe algo, sí', () => assert.equal(D.esDescontable(op()), true))
  it('a cuenta corriente con su cargo, sí; sin cargo todavía, no', () => {
    assert.equal(D.esDescontable(op({ metodo_pago: 'cuenta_corriente', enCuenta: true, estadoOp: 'pendiente' })), true)
    assert.equal(D.esDescontable(op({ metodo_pago: 'cuenta_corriente', enCuenta: false })), false)
  })
  it('quedan afuera: en curso, estimada, grupo todo junto, sin entregar, a convenir, pagada, anulada', () => {
    for (const extra of [{ enCurso: true }, { estimado: true }, { grupoTodoJunto: true }, { estadoOp: 'pendiente' },
      { estadoOp: 'despachado' }, { aConvenir: true, estado: 'a_convenir' }, { resta: 0, estado: 'pagada' }, { estadoOp: 'anulado' }]) {
      assert.equal(D.esDescontable(op(extra)), false, JSON.stringify(extra))
      assert.ok(D.porQueNo(op(extra)), JSON.stringify(extra))
    }
  })
})

describe('descuentos: reparto', () => {
  it('porcentaje: sobre lo que falta pagar de cada una', () => {
    const r = D.repartir([op({ id: 1, resta: 1000 }), op({ id: 2, resta: 500 })], { tipo: 'porcentaje', valor: 10 })
    assert.deepEqual(r.map(x => [x.id, x.monto, x.queda]), [[1, 100, 900], [2, 50, 450]])
  })
  it('monto fijo: proporcional a lo que debe cada una; el redondeo va a la última', () => {
    const r = D.repartir([op({ id: 1, resta: 200 }), op({ id: 2, resta: 100 })], { tipo: 'monto', valor: 100 })
    assert.deepEqual(r.map(x => x.monto), [66.67, 33.33])
    const t = D.repartir([op({ id: 1, resta: 100 }), op({ id: 2, resta: 100 }), op({ id: 3, resta: 100 })], { tipo: 'monto', valor: 100 })
    assert.equal(Math.round(t.reduce((s, x) => s + x.monto, 0) * 100) / 100, 100)
  })
  it('monto fijo igual a lo que deben: deja todas en cero', () => {
    const r = D.repartir([op({ id: 1, resta: 300 }), op({ id: 2, resta: 700 })], { tipo: 'monto', valor: 1000 })
    assert.deepEqual(r.map(x => x.queda), [0, 0])
  })
  it('monto mayor a lo que deben: error', () => {
    assert.throws(() => D.repartir([op({ resta: 100 })], { tipo: 'monto', valor: 100.5 }), /más de lo que debe/)
  })
  it('sin operaciones: error', () => {
    assert.throws(() => D.repartir([], { tipo: 'porcentaje', valor: 10 }), /No hay operaciones/)
  })
  it('sobre un importe (saldo total)', () => {
    assert.equal(D.montoSobre(850000, { tipo: 'porcentaje', valor: 10 }), 85000)
    assert.equal(D.montoSobre(850000, { tipo: 'monto', valor: 50000 }), 50000)
    assert.throws(() => D.montoSobre(100, { tipo: 'monto', valor: 200 }), /más de lo que debe/)
    assert.throws(() => D.montoSobre(0, { tipo: 'porcentaje', valor: 10 }), /no debe nada/)
  })
})

describe('descuentos: textos', () => {
  it('etiqueta y aviso de factura', () => {
    assert.equal(D.etiqueta({ tipo: 'porcentaje', valor: 12.5 }), '12,5%')
    assert.equal(D.etiqueta({ tipo: 'monto', valor: 50000 }), '$ 50.000')
    assert.equal(D.avisoFactura('A-0001-00001234'), 'Tiene factura emitida (N° A-0001-00001234): el descuento requiere una nota de crédito por fuera del sistema.')
    assert.equal(D.avisoFactura(null), 'Tiene factura emitida: el descuento requiere una nota de crédito por fuera del sistema.')
    assert.equal(D.facturaEmitida({ facturado: true }), true)
    assert.equal(D.facturaEmitida({ nroFactura: '123' }), true)
    assert.equal(D.facturaEmitida({}), false)
  })
})
