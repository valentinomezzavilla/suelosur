'use strict'
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { calcularPlazoAlquiler, PLAZO_ESTANDAR, PLAZO_CUENTA_CORRIENTE } = require('../src/config/alquiler')
const { sumarDiasHabiles } = require('../src/utils/diasHabiles')

const INICIO = '2026-10-05' // lunes

describe('calcularPlazoAlquiler', () => {
  it('sin cuenta corriente usa el plazo estándar', () => {
    assert.deepEqual(calcularPlazoAlquiler({ fechaInicio: INICIO, tieneCC: false }), { plazo: PLAZO_ESTANDAR })
  })

  it('con cuenta corriente usa el plazo largo por defecto', () => {
    assert.deepEqual(calcularPlazoAlquiler({ fechaInicio: INICIO, tieneCC: true }), { plazo: PLAZO_CUENTA_CORRIENTE })
  })

  it('con cuenta corriente y fin editado a mano cuenta los días hábiles', () => {
    const fin = sumarDiasHabiles(INICIO, 7)
    assert.deepEqual(calcularPlazoAlquiler({ fechaInicio: INICIO, fechaFin: fin, fechaFinManual: true, tieneCC: true }), { plazo: 7 })
  })

  it('sin cuenta corriente el fin editado a mano no alarga el plazo', () => {
    const fin = sumarDiasHabiles(INICIO, 9)
    assert.deepEqual(calcularPlazoAlquiler({ fechaInicio: INICIO, fechaFin: fin, fechaFinManual: true, tieneCC: false }), { plazo: PLAZO_ESTANDAR })
  })

  it('sin fecha de fin devuelve null', () => {
    assert.deepEqual(calcularPlazoAlquiler({ fechaInicio: INICIO, fechaFin: '2026-10-20', sinFechaFin: true, tieneCC: true }), { plazo: null })
  })

  it('histórico: sin fin es null; con fin cuenta los días aunque no tenga cuenta corriente', () => {
    assert.deepEqual(calcularPlazoAlquiler({ fechaInicio: INICIO, esHistorico: true }), { plazo: null })
    const fin = sumarDiasHabiles(INICIO, 12)
    assert.deepEqual(calcularPlazoAlquiler({ fechaInicio: INICIO, fechaFin: fin, esHistorico: true, tieneCC: false }), { plazo: 12 })
  })

  it('fin anterior al inicio es un error', () => {
    assert.deepEqual(
      calcularPlazoAlquiler({ fechaInicio: INICIO, fechaFin: '2026-10-01', fechaFinManual: true, tieneCC: true }),
      { error: 'La fecha de fin no puede ser anterior a la de inicio.' })
  })
})
