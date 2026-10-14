'use strict'

// Filtros del listado de cuentas corrientes (/clientes/cuentas). Se aplican en memoria
// sobre lo que devuelve ClientesModel.listarCuentas(): son pocas filas y así los
// totales de arriba se calculan sobre lo mismo que se ve en la tabla.

const SALDOS  = ['deuda', 'favor', 'aldia']
const ESTADOS = ['habilitada', 'deshabilitada']
const TIPOS_CLIENTE = ['Empresa', 'Particular', 'Obra']
const ORDENES = ['numero', 'cliente', 'saldo', 'movimientos']
const EPS = 0.005

const sinAcentos = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
const soloDigitos = (s) => String(s ?? '').replace(/\D/g, '')

// Query string → filtros válidos (lo desconocido se descarta)
function normalizarFiltrosCuentas(q = {}) {
  const uno = (v) => (Array.isArray(v) ? v[0] : v)
  const sort = uno(q.sort)
  return {
    q:       String(uno(q.q) ?? '').trim(),
    saldo:   SALDOS.includes(uno(q.saldo)) ? uno(q.saldo) : '',
    estado:  ESTADOS.includes(uno(q.estado)) ? uno(q.estado) : '',
    tipo:    TIPOS_CLIENTE.includes(uno(q.tipo)) ? uno(q.tipo) : '',
    enCurso: uno(q.enCurso) === 'si' ? 'si' : '',
    sort:    ORDENES.includes(sort) ? sort : '',
    dir:     String(uno(q.dir) || '').toUpperCase() === 'DESC' ? 'DESC' : 'ASC',
  }
}

// ¿El cliente coincide con el texto buscado? # de cliente, nombre/apellido (sin acentos),
// DNI/CUIT o teléfono
function coincideCliente(c, texto) {
  const t = sinAcentos(texto).replace(/^#/, '').trim()
  if (!t) return true
  const nombre = sinAcentos(`${c.nombre || ''} ${c.apellido || ''}`)
  if (t.split(/\s+/).every(p => nombre.includes(p))) return true
  if (/^\d+$/.test(t) && String(c.numero ?? '') === t) return true
  const dig = soloDigitos(t)
  if (dig.length >= 3) {
    for (const campo of [c.dni, c.cuit, c.telefono, c.tel_whatsapp]) {
      if (soloDigitos(campo).includes(dig)) return true
    }
  }
  return false
}

const nombreOrden = (c) => sinAcentos(`${c.apellido || ''} ${c.nombre || ''}`).trim()

function filtrarCuentas(cuentas, f) {
  let lista = (cuentas || []).filter(c => {
    const s = Number(c.saldo || 0)
    if (f.saldo === 'deuda' && !(s < -EPS)) return false
    if (f.saldo === 'favor' && !(s > EPS)) return false
    if (f.saldo === 'aldia' && Math.abs(s) > EPS) return false
    if (f.estado === 'habilitada' && !c.cuenta_corriente) return false
    if (f.estado === 'deshabilitada' && c.cuenta_corriente) return false
    if (f.tipo && String(c.tipo_cliente || '').toLowerCase() !== f.tipo.toLowerCase()) return false
    if (f.enCurso === 'si' && !(Number(c.cant_pendientes) > 0)) return false
    return coincideCliente(c, f.q)
  })
  if (f.sort) {
    // "saldo" ordena por deuda: ASC = el que más debe primero
    const get = {
      numero:      (c) => Number(c.numero || 0),
      cliente:     nombreOrden,
      saldo:       (c) => Number(c.saldo || 0),
      movimientos: (c) => Number(c.cant_movimientos || 0),
    }[f.sort]
    const k = f.dir === 'DESC' ? -1 : 1
    lista = [...lista].sort((a, b) => {
      const va = get(a), vb = get(b)
      return va < vb ? -k : va > vb ? k : 0
    })
  }
  return lista
}

module.exports = { normalizarFiltrosCuentas, filtrarCuentas, coincideCliente, TIPOS_CLIENTE }
