'use strict'
// Liquidaciones: lógica pura (sin base). Estado de pago de cada operación, totales,
// agrupados y filtros. Ver docs/superpowers/specs/2026-10-06-liquidaciones-design.md

const TIPOS = {
  cantera:    'Venta en cantera',
  viaje:      'Venta con viaje',
  contenedor: 'Alquiler de contenedor',
  maquinaria: 'Alquiler de maquinaria',
}
const ESTADOS = { pagada: 'Pagada', parcial: 'Parcial', pendiente: 'Pendiente', a_convenir: 'Precio a convenir' }
const METODOS = {
  efectivo: 'Efectivo', transferencia: 'Transferencia', cheque: 'Cheque', echeq: 'Echeq',
  cuenta_corriente: 'Cuenta corriente', saldo_a_favor: 'Saldo a favor', a_convenir: 'A convenir',
}
const ESTADOS_FILTRO = ['todas', 'pendientes', 'pagadas']
const CENTAVO = 0.01

const redondear = (n) => Math.round((Number(n) || 0) * 100) / 100
const fechaValida = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !Number.isNaN(new Date(s + 'T00:00:00').getTime())
  && new Date(s + 'T00:00:00').toISOString().slice(0, 10) === s

function rangoMes(hoy) {
  const [a, m] = hoy.split('-').map(Number)
  const ultimo = new Date(Date.UTC(a, m, 0)).getUTCDate()
  const mm = String(m).padStart(2, '0')
  return { desde: `${a}-${mm}-01`, hasta: `${a}-${mm}-${String(ultimo).padStart(2, '0')}` }
}

// Filtros de la URL → filtros limpios. Lo inválido se ignora (vale el default).
function normalizarFiltros(q = {}, hoy) {
  const mes = rangoMes(hoy)
  const clienteId = /^\d+$/.test(String(q.clienteId || '').trim()) ? String(q.clienteId).trim() : null
  const obra = clienteId && String(q.obra || '').trim() ? String(q.obra).trim() : null
  const pedidos = (Array.isArray(q.tipos) ? q.tipos : [q.tipos]).filter(t => Object.hasOwn(TIPOS, t))
  return {
    clienteId,
    obra,
    desde: fechaValida(q.desde) ? q.desde : mes.desde,
    hasta: fechaValida(q.hasta) ? q.hasta : mes.hasta,
    tipos: pedidos.length ? Object.keys(TIPOS).filter(t => pedidos.includes(t)) : Object.keys(TIPOS),
    estadoPago: ESTADOS_FILTRO.includes(q.estadoPago) ? q.estadoPago : 'todas',
  }
}

function tipoDeOperacion({ tipo_op, modalidad }) {
  if (tipo_op === 'M') return modalidad === 'flete' ? 'viaje' : 'cantera'
  if (tipo_op === 'C') return 'contenedor'
  if (tipo_op === 'MA') return 'maquinaria'
  return null
}

function estadoDe(total, pagado) {
  if (total - pagado <= CENTAVO) return 'pagada'
  return pagado > CENTAVO ? 'parcial' : 'pendiente'
}

// cobrado: lo cobrado por transacciones de contado de la operación.
// cc: { total, pagado } del cargo en cuenta corriente (imputación FIFO), o undefined si no hay cargo.
function estadoPago({ total, aConvenir, metodoPago, cobrado = 0, cc }) {
  if (aConvenir) return { pagado: 0, resta: 0, estado: 'a_convenir' }
  const t = redondear(total)
  let pagado
  if (metodoPago === 'saldo_a_favor') pagado = t
  else if (metodoPago === 'cuenta_corriente') pagado = cc ? Number(cc.pagado) || 0 : 0
  else pagado = Number(cobrado) || 0
  pagado = redondear(Math.min(Math.max(pagado, 0), t))
  const estado = estadoDe(t, pagado)
  return { pagado: estado === 'pagada' ? t : pagado, resta: estado === 'pagada' ? 0 : redondear(t - pagado), estado }
}

// Alquiler agrupado con cobro "todo junto": el cargo / cobro es uno para todo el grupo y
// está anclado a una OP (la que trae _pagadoGrupo y _totalGrupo). Lo pagado del grupo se
// reparte entre sus OPs en proporción a su total.
function repartirGrupos(ops) {
  const anclas = new Map()
  for (const o of ops) {
    if (o.grupoTodoJunto && o.id_grupo != null && o._totalGrupo > 0) anclas.set(String(o.id_grupo), o._pagadoGrupo / o._totalGrupo)
  }
  for (const o of ops) {
    if (!o.grupoTodoJunto || o.aConvenir || o.estado === 'a_convenir') continue
    const proporcion = anclas.get(String(o.id_grupo))
    if (proporcion == null) continue
    const t = redondear(o.total)
    const pagado = redondear(Math.min(t, t * proporcion))
    o.estado = estadoDe(t, pagado)
    o.pagado = o.estado === 'pagada' ? t : pagado
    o.resta = o.estado === 'pagada' ? 0 : redondear(t - pagado)
  }
  return ops
}

function filtrarPorEstado(ops, estadoPago) {
  if (estadoPago === 'pendientes') return ops.filter(o => o.estado === 'pendiente' || o.estado === 'parcial')
  if (estadoPago === 'pagadas') return ops.filter(o => o.estado === 'pagada')
  return ops
}

function resumir(ops) {
  const cuentan = ops.filter(o => o.estado !== 'a_convenir')
  const suma = (k) => redondear(cuentan.reduce((s, o) => s + (Number(o[k]) || 0), 0))
  return { consumido: suma('total'), pagado: suma('pagado'), saldo: suma('resta'), cantidad: ops.length }
}

// El nombre que se muestra es el de la primera operación del grupo.
function agruparPor(ops, claveFn, nombreFn) {
  const grupos = new Map()
  for (const o of ops) {
    const clave = claveFn(o)
    if (!grupos.has(clave)) grupos.set(clave, { clave, nombre: nombreFn(o), operaciones: [] })
    grupos.get(clave).operaciones.push(o)
  }
  return [...grupos.values()]
    .map(g => ({ ...g, resumen: resumir(g.operaciones) }))
    .sort((a, b) => String(a.nombre).localeCompare(String(b.nombre), 'es'))
}

function nroLiquidacion(hoy, clienteId) {
  const fecha = String(hoy).replace(/-/g, '')
  return `LIQ-${fecha}-${clienteId != null ? String(clienteId).padStart(4, '0') : 'GRAL'}`
}

function diasEntre(desde, hasta) {
  const d = (s) => new Date(String(s).slice(0, 10) + 'T00:00:00Z').getTime()
  return Math.max(1, Math.round((d(hasta) - d(desde)) / 86400000))
}

module.exports = {
  TIPOS, ESTADOS, METODOS,
  rangoMes, normalizarFiltros, tipoDeOperacion, estadoPago, repartirGrupos,
  filtrarPorEstado, resumir, agruparPor, nroLiquidacion, diasEntre,
}
