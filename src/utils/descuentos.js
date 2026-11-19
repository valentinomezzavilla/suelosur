'use strict'
// Descuentos a clientes: lógica pura (sin base). Qué operaciones se pueden descontar, cómo se
// reparte un descuento y sus textos. Ver docs/superpowers/specs/2026-11-19-descuentos-design.md
//
// El descuento es sobre lo que FALTA PAGAR (resta) de cada operación: un 10% de "todas" no toca
// las ya pagadas, y un monto fijo nunca supera lo que se debe (no genera saldo a favor).

const TIPOS = ['porcentaje', 'monto']
const ALCANCES = ['todas', 'operacion', 'remito', 'factura', 'saldo']
const ALCANCE_TEXTO = {
  todas: 'Todas las operaciones', operacion: 'Una operación', remito: 'Remito', factura: 'Factura', saldo: 'Sobre el saldo total',
}
const METODOS_EN_CUENTA = ['cuenta_corriente', 'saldo_a_favor']
const SIN_ENTREGAR = ['pendiente', 'despachado']
const CENTAVO = 0.005

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100

// "250.000,50" / "250000.5" / 10 → número (o NaN)
function leerNumero(v) {
  if (typeof v === 'number') return v
  let s = String(v ?? '').trim().replace(/\s|\$/g, '')
  if (!s) return NaN
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.')
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '')
  return Number(s)
}

// Pedido del formulario → pedido limpio, o { error }
function validar({ tipo, valor, alcance, referencia } = {}) {
  if (!TIPOS.includes(tipo)) return { error: 'Elegí si el descuento es un porcentaje o un monto fijo.' }
  const v = r2(leerNumero(valor))
  if (!Number.isFinite(v) || v <= 0) return { error: 'Ingresá un valor mayor a cero.' }
  if (tipo === 'porcentaje' && v > 100) return { error: 'El porcentaje no puede ser mayor a 100.' }
  if (!ALCANCES.includes(alcance)) return { error: 'Elegí a qué se aplica el descuento.' }
  const ref = String(referencia ?? '').trim()
  if (['operacion', 'remito', 'factura'].includes(alcance) && !ref) {
    return { error: { operacion: 'Elegí la operación.', remito: 'Elegí el N° de remito.', factura: 'Elegí el N° de factura.' }[alcance] }
  }
  return { tipo, valor: v, alcance, referencia: ['operacion', 'remito', 'factura'].includes(alcance) ? ref : null }
}

// Por qué una operación (armada por Liquidaciones) no se puede descontar; null si se puede.
// Solo lo que ya es deuda: a cuenta corriente con su cargo, o de contado ya entregada.
function porQueNo(o) {
  if (!o) return 'No existe.'
  if (o.estadoOp === 'anulado') return 'Está anulada.'
  if (o.aConvenir || o.estado === 'a_convenir') return 'Tiene el precio a convenir.'
  if (o.enCurso || o.estimado) return 'Es un alquiler en curso: el importe todavía no es el final.'
  if (o.grupoTodoJunto) return 'Es parte de un alquiler agrupado que se cobra todo junto.'
  if ((Number(o.resta) || 0) <= CENTAVO * 2) return 'No debe nada.'
  if (METODOS_EN_CUENTA.includes(o.metodo_pago)) { if (!o.enCuenta) return 'Todavía no tiene el cargo en la cuenta corriente.' }
  else if (SIN_ENTREGAR.includes(o.estadoOp)) return 'Todavía no se entregó.'
  return null
}
const esDescontable = (o) => porQueNo(o) === null

// Reparte el descuento entre `ops` (las que se pueden descontar, con `resta`).
// → [{ id, resta, monto, queda }] en el mismo orden. Tira Error si no se puede.
function repartir(ops, { tipo, valor }) {
  const lista = (ops || []).filter(o => (Number(o.resta) || 0) > CENTAVO)
  if (!lista.length) throw new Error('No hay operaciones con saldo pendiente para descontar.')
  const deben = r2(lista.reduce((s, o) => s + Number(o.resta), 0))
  let montos
  if (tipo === 'porcentaje') {
    montos = lista.map(o => r2(Number(o.resta) * valor / 100))
  } else {
    if (valor - deben > CENTAVO) throw new Error(`El descuento no puede ser más de lo que debe: ${etiqueta({ tipo: 'monto', valor: deben })}.`)
    const total = Math.min(r2(valor), deben)
    montos = lista.map(o => r2(total * Number(o.resta) / deben))
    // El redondeo va a la última (sin pasarse de lo que debe)
    const ultima = lista.length - 1
    montos[ultima] = r2(Math.min(Number(lista[ultima].resta), total - montos.slice(0, ultima).reduce((s, m) => s + m, 0)))
  }
  return lista.map((o, i) => ({ id: o.id, resta: r2(o.resta), monto: montos[i], queda: r2(Number(o.resta) - montos[i]) }))
    .filter(x => x.monto > CENTAVO)
}

// Descuento sobre un importe (el saldo total del cliente)
function montoSobre(base, { tipo, valor }) {
  const b = r2(base)
  if (b <= CENTAVO) throw new Error('El cliente no debe nada: no hay saldo para descontar.')
  if (tipo === 'porcentaje') return r2(b * valor / 100)
  if (valor - b > CENTAVO) throw new Error(`El descuento no puede ser más de lo que debe: ${etiqueta({ tipo: 'monto', valor: b })}.`)
  return r2(Math.min(valor, b))
}

const pesos = (n) => '$ ' + r2(n).toLocaleString('es-AR', { minimumFractionDigits: 0, maximumFractionDigits: 2 })
function etiqueta({ tipo, valor }) {
  return tipo === 'porcentaje' ? `${Number(valor).toLocaleString('es-AR', { maximumFractionDigits: 2 })}%` : pesos(valor)
}

const facturaEmitida = (o) => !!(o && (o.facturado || o.nroFactura || o.nro_factura))
const avisoFactura = (nro) => `Tiene factura emitida${nro ? ` (N° ${nro})` : ''}: el descuento requiere una nota de crédito por fuera del sistema.`

module.exports = {
  TIPOS, ALCANCES, ALCANCE_TEXTO, leerNumero, validar, porQueNo, esDescontable, repartir, montoSobre, etiqueta, pesos,
  facturaEmitida, avisoFactura,
}
