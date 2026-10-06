'use strict'
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const L = require('../src/utils/liquidaciones')

describe('rangoMes / normalizarFiltros', () => {
  it('rango del mes de la fecha dada', () => {
    assert.deepEqual(L.rangoMes('2026-10-06'), { desde: '2026-10-01', hasta: '2026-10-31' })
    assert.deepEqual(L.rangoMes('2024-02-10'), { desde: '2024-02-01', hasta: '2024-02-29' })
  })
  it('sin parámetros: todo por defecto', () => {
    assert.deepEqual(L.normalizarFiltros({}, '2026-10-06'), {
      clienteId: null, obra: null, desde: '2026-10-01', hasta: '2026-10-31',
      tipos: ['cantera', 'viaje', 'contenedor', 'maquinaria'], estadoPago: 'todas',
    })
  })
  it('respeta valores válidos (tipos como string o array)', () => {
    const f = L.normalizarFiltros({ clienteId: '42', obra: 'colon 100', desde: '2026-01-01', hasta: '2026-03-31', tipos: 'viaje', estadoPago: 'pendientes' }, '2026-10-06')
    assert.deepEqual(f, { clienteId: '42', obra: 'colon 100', desde: '2026-01-01', hasta: '2026-03-31', tipos: ['viaje'], estadoPago: 'pendientes' })
    assert.deepEqual(L.normalizarFiltros({ tipos: ['cantera', 'maquinaria'] }, '2026-10-06').tipos, ['cantera', 'maquinaria'])
  })
  it('ignora valores manipulados y usa los defaults', () => {
    const f = L.normalizarFiltros({ clienteId: 'abc', desde: 'hola', hasta: '2026-13-45', tipos: ['xxx'], estadoPago: 'raro' }, '2026-10-06')
    assert.deepEqual(f, {
      clienteId: null, obra: null, desde: '2026-10-01', hasta: '2026-10-31',
      tipos: ['cantera', 'viaje', 'contenedor', 'maquinaria'], estadoPago: 'todas',
    })
  })
  it('la obra solo vale con cliente', () => {
    assert.equal(L.normalizarFiltros({ obra: 'colon 100' }, '2026-10-06').obra, null)
  })
})

describe('tipoDeOperacion', () => {
  it('distingue los cuatro tipos', () => {
    assert.equal(L.tipoDeOperacion({ tipo_op: 'M', modalidad: 'flete' }), 'viaje')
    assert.equal(L.tipoDeOperacion({ tipo_op: 'M', modalidad: 'retiro' }), 'cantera')
    assert.equal(L.tipoDeOperacion({ tipo_op: 'M', modalidad: null }), 'cantera')
    assert.equal(L.tipoDeOperacion({ tipo_op: 'C' }), 'contenedor')
    assert.equal(L.tipoDeOperacion({ tipo_op: 'MA' }), 'maquinaria')
    assert.equal(L.tipoDeOperacion({ tipo_op: 'X' }), null)
  })
})

describe('estadoPago', () => {
  it('precio a convenir: no suma nada', () => {
    assert.deepEqual(L.estadoPago({ total: 0, aConvenir: true, metodoPago: null }), { pagado: 0, resta: 0, estado: 'a_convenir' })
  })
  it('contado cobrado = pagada; sin cobro = pendiente', () => {
    assert.deepEqual(L.estadoPago({ total: 1000, metodoPago: 'efectivo', cobrado: 1000 }), { pagado: 1000, resta: 0, estado: 'pagada' })
    assert.deepEqual(L.estadoPago({ total: 1000, metodoPago: 'transferencia', cobrado: 0 }), { pagado: 0, resta: 1000, estado: 'pendiente' })
  })
  it('a convenir (método) y sin método se tratan como contado', () => {
    assert.equal(L.estadoPago({ total: 500, metodoPago: 'a_convenir', cobrado: 500 }).estado, 'pagada')
    assert.equal(L.estadoPago({ total: 500, metodoPago: null, cobrado: 0 }).estado, 'pendiente')
  })
  it('saldo a favor: pagada en el momento', () => {
    assert.deepEqual(L.estadoPago({ total: 800, metodoPago: 'saldo_a_favor' }), { pagado: 800, resta: 0, estado: 'pagada' })
  })
  it('cuenta corriente: según la imputación FIFO', () => {
    assert.deepEqual(L.estadoPago({ total: 1000, metodoPago: 'cuenta_corriente', cc: { total: 1000, pagado: 400 } }), { pagado: 400, resta: 600, estado: 'parcial' })
    assert.deepEqual(L.estadoPago({ total: 1000, metodoPago: 'cuenta_corriente', cc: { total: 1000, pagado: 1000 } }), { pagado: 1000, resta: 0, estado: 'pagada' })
    assert.deepEqual(L.estadoPago({ total: 1000, metodoPago: 'cuenta_corriente', cc: undefined }), { pagado: 0, resta: 1000, estado: 'pendiente' })
  })
  it('nunca paga de más ni deja resta negativa', () => {
    assert.deepEqual(L.estadoPago({ total: 1000, metodoPago: 'efectivo', cobrado: 1500 }), { pagado: 1000, resta: 0, estado: 'pagada' })
    assert.deepEqual(L.estadoPago({ total: 1000, metodoPago: 'cuenta_corriente', cc: { total: 1000, pagado: 1200 } }), { pagado: 1000, resta: 0, estado: 'pagada' })
  })
  it('diferencias de centavos cuentan como pagada', () => {
    assert.equal(L.estadoPago({ total: 1000, metodoPago: 'cuenta_corriente', cc: { total: 1000, pagado: 999.995 } }).estado, 'pagada')
  })
})

describe('repartirGrupos', () => {
  it('grupo "todo junto": las OPs sin registro propio toman lo pagado del grupo en proporción', () => {
    const ops = [
      { id: 1, id_grupo: 7, grupoTodoJunto: true, total: 3000, pagado: 0, resta: 0, estado: 'pendiente', _sinRegistroPago: false, _pagadoGrupo: 2000, _totalGrupo: 4000 },
      { id: 2, id_grupo: 7, grupoTodoJunto: true, total: 1000, pagado: 0, resta: 1000, estado: 'pendiente', _sinRegistroPago: true },
    ]
    // La OP 1 tiene el cargo de todo el grupo (4000) con 2000 pagados → 50 %
    L.repartirGrupos(ops)
    assert.deepEqual(ops.map(o => [o.pagado, o.resta, o.estado]), [[1500, 1500, 'parcial'], [500, 500, 'parcial']])
  })
  it('grupo pagado completo → todas pagadas', () => {
    const ops = [
      { id: 1, id_grupo: 7, grupoTodoJunto: true, total: 3000, pagado: 0, resta: 0, estado: 'pendiente', _sinRegistroPago: false, _pagadoGrupo: 4000, _totalGrupo: 4000 },
      { id: 2, id_grupo: 7, grupoTodoJunto: true, total: 1000, pagado: 0, resta: 1000, estado: 'pendiente', _sinRegistroPago: true },
    ]
    L.repartirGrupos(ops)
    assert.deepEqual(ops.map(o => o.estado), ['pagada', 'pagada'])
  })
  it('no toca OPs sin grupo ni grupos que se cobran por contenedor', () => {
    const ops = [
      { id: 3, id_grupo: null, total: 100, pagado: 0, resta: 100, estado: 'pendiente', _sinRegistroPago: true },
      { id: 4, id_grupo: 8, grupoTodoJunto: false, total: 100, pagado: 0, resta: 100, estado: 'pendiente', _sinRegistroPago: true },
    ]
    L.repartirGrupos(ops)
    assert.deepEqual(ops.map(o => o.estado), ['pendiente', 'pendiente'])
  })
  it('las OPs a convenir del grupo siguen a convenir', () => {
    const ops = [
      { id: 1, id_grupo: 7, grupoTodoJunto: true, total: 1000, pagado: 0, resta: 0, estado: 'pendiente', _sinRegistroPago: false, _pagadoGrupo: 1000, _totalGrupo: 1000 },
      { id: 2, id_grupo: 7, grupoTodoJunto: true, aConvenir: true, total: 0, pagado: 0, resta: 0, estado: 'a_convenir', _sinRegistroPago: true },
    ]
    L.repartirGrupos(ops)
    assert.deepEqual(ops.map(o => o.estado), ['pagada', 'a_convenir'])
  })
})

describe('filtrarPorEstado / resumir / agruparPor', () => {
  const ops = [
    { id: 1, total: 1000, pagado: 1000, resta: 0, estado: 'pagada', obra: 'Colón 100', id_cliente: 1 },
    { id: 2, total: 500, pagado: 200, resta: 300, estado: 'parcial', obra: 'colon 100', id_cliente: 1 },
    { id: 3, total: 300, pagado: 0, resta: 300, estado: 'pendiente', obra: 'Vélez 10', id_cliente: 2 },
    { id: 4, total: 0, pagado: 0, resta: 0, estado: 'a_convenir', obra: '', id_cliente: 2 },
  ]
  it('filtra por estado de pago', () => {
    assert.deepEqual(L.filtrarPorEstado(ops, 'todas').map(o => o.id), [1, 2, 3, 4])
    assert.deepEqual(L.filtrarPorEstado(ops, 'pendientes').map(o => o.id), [2, 3])
    assert.deepEqual(L.filtrarPorEstado(ops, 'pagadas').map(o => o.id), [1])
  })
  it('resume sin contar las a convenir', () => {
    assert.deepEqual(L.resumir(ops), { consumido: 1800, pagado: 1200, saldo: 600, cantidad: 4 })
    assert.deepEqual(L.resumir([]), { consumido: 0, pagado: 0, saldo: 0, cantidad: 0 })
  })
  it('agrupa por una clave y ordena por nombre', () => {
    const g = L.agruparPor(ops.slice(0, 3), o => o.obra.toLowerCase().replace('ó', 'o'), o => o.obra)
    assert.deepEqual(g.map(x => [x.nombre, x.operaciones.length, x.resumen.saldo]), [['Colón 100', 2, 300], ['Vélez 10', 1, 300]])
  })
})

describe('nroLiquidacion / diasEntre', () => {
  it('arma el número informativo', () => {
    assert.equal(L.nroLiquidacion('2026-10-06', 42), 'LIQ-20261006-0042')
    assert.equal(L.nroLiquidacion('2026-10-06', null), 'LIQ-20261006-GRAL')
  })
  it('días entre fechas, mínimo 1', () => {
    assert.equal(L.diasEntre('2026-10-01', '2026-10-06'), 5)
    assert.equal(L.diasEntre('2026-10-01', '2026-10-01 18:00:00'), 1)
  })
})
