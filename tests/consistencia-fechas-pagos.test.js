'use strict'
// Fechas de compra / pago, imputación única de la cuenta corriente, relación Liquidación ↔
// Cuenta corriente, sueldos del mes y listado de Transacciones. Lógica pura: sin base.
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { leerFechaPago, fechaHoraDePago } = require('../src/utils/fechaPago')
const { fechaDeOperacion, sqlFechaOperacion } = require('../src/utils/fechaOperacion')
const { imputar, porOperacion } = require('../src/utils/imputacion')
const L = require('../src/utils/liquidaciones')
const S = require('../src/utils/sueldos')

describe('fecha de pago', () => {
  const hoy = '2026-11-04'
  it('vacía = hoy', () => {
    assert.deepEqual(leerFechaPago('', { hoy }), { fecha: hoy, error: null })
    assert.deepEqual(leerFechaPago(undefined, { hoy }), { fecha: hoy, error: null })
  })
  it('acepta un día anterior (se pagó el viernes y se carga hoy)', () => {
    assert.deepEqual(leerFechaPago('2026-10-30', { hoy }), { fecha: '2026-10-30', error: null })
  })
  it('no acepta fechas futuras ni mal formadas', () => {
    assert.match(leerFechaPago('2026-11-05', { hoy }).error, /posterior a hoy/)
    assert.match(leerFechaPago('2026-02-30', { hoy }).error, /no es válida/)
    assert.match(leerFechaPago('30/10/2026', { hoy }).error, /no es válida/)
    assert.match(leerFechaPago('2026-11-05', { hoy, etiqueta: 'La fecha de compra' }).error, /^La fecha de compra/)
  })
  it('hoy se guarda con la hora real (null); un día anterior, a las 12:00', () => {
    assert.equal(fechaHoraDePago(hoy, hoy), null)
    assert.equal(fechaHoraDePago(null, hoy), null)
    assert.equal(fechaHoraDePago('2026-10-30', hoy), '2026-10-30 12:00:00')
  })
})

describe('fecha de la operación (regla única)', () => {
  it('venta (cantera o viaje): la fecha de compra, aunque el envío sea otro día', () => {
    assert.equal(fechaDeOperacion({ tipo_op: 'M', fecha_emision: '2026-09-28', fecha_entrega_planificada: '2026-10-02' }), '2026-09-28')
  })
  it('alquiler: el inicio; sin inicio, la emisión', () => {
    assert.equal(fechaDeOperacion({ tipo_op: 'C', fecha_emision: '2026-09-28', fecha_entrega_planificada: '2026-10-02' }), '2026-10-02')
    assert.equal(fechaDeOperacion({ tipo_op: 'MA', fecha_emision: '2026-09-28 10:00:00', fecha_entrega_planificada: null }), '2026-09-28')
  })
  it('la expresión SQL sigue la misma regla', () => {
    const sql = sqlFechaOperacion('x')
    assert.match(sql, /WHEN x\.tipo_op = 'M' THEN x\.fecha_emision/)
    assert.match(sql, /COALESCE\(NULLIF\(x\.fecha_entrega_planificada, ''\), x\.fecha_emision\)/)
  })
})

describe('imputación de pagos (FIFO único)', () => {
  const mov = (id, monto, extra = {}) => ({ id, monto, tipo: monto < 0 ? 'deuda' : 'pago', ...extra })

  it('los pagos cubren primero los cargos más viejos', () => {
    const { cargos, aFavor } = imputar([mov(1, -100, { id_op_encabezado: 10 }), mov(2, -50, { id_op_encabezado: 11 }), mov(3, 120)])
    assert.equal(cargos[1].restante, 0)
    assert.equal(cargos[2].restante, 30)
    assert.equal(aFavor, 0)
    assert.deepEqual(porOperacion(cargos), { 10: { total: 100, pagado: 100 }, 11: { total: 50, pagado: 20 } })
  })

  it('un pago adelantado (saldo a favor) cubre la compra que viene después', () => {
    // Antes Liquidaciones perdía ese pago y mostraba la compra como pendiente
    const { cargos, aFavor } = imputar([mov(1, 500), mov(2, -500, { id_op_encabezado: 20 })])
    assert.equal(cargos[2].restante, 0)
    assert.equal(aFavor, 0)
    assert.deepEqual(porOperacion(cargos)[20], { total: 500, pagado: 500 })
  })

  it('usar el saldo a favor consume el crédito (no se usa dos veces)', () => {
    const movs = [mov(1, 100), mov(2, -100, { tipo: 'uso_saldo_favor', id_op_encabezado: 30 }), mov(3, -100, { id_op_encabezado: 31 })]
    const { cargos, aFavor } = imputar(movs)
    assert.equal(cargos[2].restante, 0)
    assert.equal(cargos[3].restante, 100)   // la compra siguiente sigue debiéndose
    assert.equal(aFavor, 0)
  })

  it('invariante: lo que falta de los cargos menos lo a favor = la deuda de la cuenta', () => {
    const movs = [mov(1, -300), mov(2, 50), mov(3, -20, { tipo: 'ajuste' }), mov(4, 400), mov(5, -80, { tipo: 'uso_saldo_favor' }), mov(6, -60), mov(7, 5, { tipo: 'ajuste' })]
    const { cargos, aFavor } = imputar(movs)
    const restante = Object.values(cargos).reduce((s, c) => s + c.restante, 0)
    const deuda = -movs.reduce((s, m) => s + m.monto, 0)
    assert.equal(Math.round((restante - aFavor) * 100) / 100, deuda)
  })
})

describe('saldo del cliente (el mismo en Cuenta corriente y en Liquidación)', () => {
  const op = (id, resta, extra = {}) => ({ id, nro_op: id, fecha: '2026-10-10', resta, total: resta, estado: resta > 0 ? 'pendiente' : 'pagada',
    metodo_pago: 'cuenta_corriente', enCuenta: true, estadoOp: 'entregado', tipo: 'viaje', tipoTexto: 'Venta con viaje', ...extra })
  const periodo = { desde: '2026-10-01', hasta: '2026-10-31' }

  it('todo es del período: la cuenta corriente es el total', () => {
    const r = L.saldoDelCliente({ cargos: { 1: { idOp: 10, restante: 100, fechaOp: '2026-10-05' } }, aFavor: 0,
      ops: [op(10, 100)], saldoCuenta: -100, ...periodo })
    assert.equal(r.cuenta.saldo, -100)
    assert.deepEqual(r.cuenta.desglose, { periodo: 100, anteriores: 0, posteriores: 0, manuales: 0 })
    assert.equal(r.cuenta.coincideConMovimientos, true)
    assert.equal(r.total, 100)
  })

  it('separa la deuda por período y lo que no va a la cuenta corriente', () => {
    const r = L.saldoDelCliente({
      cargos: {
        1: { idOp: 10, restante: 100, fechaOp: '2026-10-05' },   // del período
        2: { idOp: 5,  restante: 649.8, fechaOp: '2026-09-20' }, // septiembre
        3: { idOp: null, restante: 50 },                          // cargo a mano
        4: { idOp: 12, restante: 30, fechaOp: '2026-11-07' },    // posterior
        5: { idOp: 13, restante: 0, fechaOp: '2026-10-07' },     // pagado: no cuenta
      },
      aFavor: 0,
      ops: [
        op(10, 100),
        op(11, 70, { metodo_pago: 'efectivo', enCuenta: false }),                                            // contado sin cobrar
        op(14, 40, { metodo_pago: 'cuenta_corriente', enCuenta: false, enCurso: true, tipo: 'contenedor' }), // alquiler en curso
        op(15, 25, { metodo_pago: 'efectivo', enCuenta: false, estadoOp: 'pendiente' }),                     // viaje sin entregar
        op(16, 0, { estado: 'a_convenir', enCuenta: false }),                                                // sin precio: no cuenta
      ],
      saldoCuenta: -829.8, ...periodo,
    })
    assert.deepEqual(r.cuenta.desglose, { periodo: 100, anteriores: 649.8, posteriores: 30, manuales: 50 })
    assert.equal(r.cuenta.deuda, 829.8)
    assert.equal(r.sinCobrar.total, 70)
    assert.deepEqual(r.sinCobrar.ops.map(o => o.id), [11])
    assert.deepEqual(r.enCurso.ops.map(o => o.id), [14])
    assert.deepEqual(r.programadas.ops.map(o => o.id), [15])
    assert.equal(r.total, 899.8) // cuenta corriente + sin cobrar
  })

  it('avisa si el saldo guardado no coincide con los movimientos', () => {
    const r = L.saldoDelCliente({ cargos: { 1: { idOp: 10, restante: 100, fechaOp: '2026-10-05' } }, aFavor: 0,
      ops: [op(10, 100)], saldoCuenta: -150, saldoMovimientos: -100, ...periodo })
    assert.equal(r.cuenta.coincideConMovimientos, false)
  })

  it('saldo a favor: dice de qué pagos sale', () => {
    const creditos = [{ id: 7, fecha: '2026-10-02 12:00:00', tipo: 'pago', descripcion: 'Pago / abono de deuda', monto: 500, sobrante: 200 }]
    const r = L.saldoDelCliente({ cargos: {}, aFavor: 200, creditos, ops: [], saldoCuenta: 200, ...periodo })
    assert.equal(r.cuenta.saldo, 200)
    assert.equal(r.cuenta.aFavor, 200)
    assert.deepEqual(r.cuenta.creditos.map(c => [c.fecha, c.sobrante, c.monto]), [['2026-10-02', 200, 500]])
    assert.equal(r.total, -200)
  })
})

describe('sueldos del mes', () => {
  it('sueldo + anticipo + liquidación − descuentos; viáticos y extras aparte', () => {
    assert.deepEqual(S.totalesDelMes([
      { tipo: 'sueldo', total: 800 }, { tipo: 'anticipo', total: 200 }, { tipo: 'descuento', total: 50 },
      { tipo: 'viatico', total: 30 }, { tipo: 'horas_extra', total: 20 },
    ]), { sueldo: 950, otros: 50 })
  })
  it('estado frente al sueldo de la ficha', () => {
    assert.equal(S.estadoSueldo(1000, 1000), 'pagado')
    assert.equal(S.estadoSueldo(1000, 400), 'parcial')
    assert.equal(S.estadoSueldo(1000, 0), 'sin_pagar')
    assert.equal(S.estadoSueldo(0, 0), 'sin_sueldo')
    assert.equal(S.estadoSueldo(0, 500), 'pagado')
  })
  it('mes válido', () => {
    assert.equal(S.mesValido('2026-10'), '2026-10')
    assert.equal(S.mesValido('2026-13'), null)
    assert.equal(S.mesValido('x'), null)
  })
})

describe('Transacciones: entradas y salidas', () => {
  const M = require('../src/models/movimientosDinero.model')

  it('botones en orden, empezando por Todas', () => {
    assert.deepEqual(M.CLAVES, ['todas', 'ventas', 'alquileres', 'pagos_clientes', 'sueldos', 'compras', 'ajustes'])
  })
  it('el botón filtra por categoría; "todas" no filtra', () => {
    assert.deepEqual(M._filtro({ categoria: 'sueldos' }), { where: 'WHERE u.categoria = ?', params: ['sueldos'] })
    assert.deepEqual(M._filtro({ categoria: 'todas' }), { where: '', params: [] })
    assert.deepEqual(M._filtro({ categoria: 'cualquiera' }), { where: '', params: [] })
  })
  it('remito e id son solo de cobros; la fecha es la de pago', () => {
    const { where, params } = M._filtro({ remito: '15', fechaDesde: '2026-10-01', fechaHasta: '2026-10-31' })
    assert.match(where, /u\.origen = 'transaccion' AND u\.nro_remito = \?/)
    assert.match(where, /LEFT\(u\.fecha, 10\) >= \?/)
    assert.deepEqual(params, [15, '2026-10-01', '2026-10-31'])
  })
  it('las ventas a cuenta corriente no suman a lo que entró', () => {
    assert.deepEqual(M.totalesDe([
      { sentido: 'entrada', monto: 1000 }, { sentido: 'salida', monto: 300 }, { sentido: 'a_cuenta', monto: 500 },
    ]), { entradas: 1000, salidas: 300, neto: 700, aCuenta: 500 })
  })
  it('códigos legibles por origen', () => {
    assert.equal(M.codigo({ origen: 'pago_cliente', id: 12 }), 'PAG-000012')
    assert.equal(M.codigo({ origen: 'egreso', id: 7 }), 'EGR-000007')
    assert.equal(M.codigo({ origen: 'transaccion', tipo: 'Venta Viaje', numero: 3 }), 'VIA-000003')
  })
})
