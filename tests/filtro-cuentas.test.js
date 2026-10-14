'use strict'
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { normalizarFiltrosCuentas, filtrarCuentas } = require('../src/utils/filtroCuentas')

const cuentas = [
  { id: 1, numero: 12, nombre: 'José', apellido: 'Pérez', dni: '30111222', telefono: '351-555-1234', saldo: -5000, cuenta_corriente: 1, tipo_cliente: 'Particular', cant_pendientes: 0, cant_movimientos: 4 },
  { id: 2, numero: 7, nombre: 'FEHUSA', apellido: 'FEHUSA', cuit: '30-71234567-9', saldo: 2000, cuenta_corriente: 1, tipo_cliente: 'Empresa', cant_pendientes: 2, cant_movimientos: 9 },
  { id: 3, numero: 30, nombre: 'Ana', apellido: 'Gómez', tel_whatsapp: '3515559999', saldo: 0, cuenta_corriente: 0, tipo_cliente: 'Obra', cant_pendientes: 1, cant_movimientos: 0 },
  { id: 4, numero: 5, nombre: 'Luis', apellido: 'Arce', saldo: -20000, cuenta_corriente: 1, tipo_cliente: 'empresa', cant_pendientes: 0, cant_movimientos: 1 },
]
const ids = (l) => l.map(c => c.id)
const f = (q) => normalizarFiltrosCuentas(q)

describe('normalizarFiltrosCuentas', () => {
  it('descarta valores desconocidos', () => {
    assert.deepEqual(f({ saldo: 'x', estado: 'y', tipo: 'z', enCurso: 'no', sort: 'drop', dir: 'nope' }),
      { q: '', saldo: '', estado: '', tipo: '', enCurso: '', sort: '', dir: 'ASC' })
  })
  it('toma el primero si viene repetido', () => {
    assert.equal(f({ saldo: ['deuda', 'favor'] }).saldo, 'deuda')
  })
})

describe('filtrarCuentas', () => {
  it('sin filtros devuelve todo en el orden original', () => {
    assert.deepEqual(ids(filtrarCuentas(cuentas, f({}))), [1, 2, 3, 4])
  })
  it('busca cliente por nombre sin acentos y por nombre + apellido', () => {
    assert.deepEqual(ids(filtrarCuentas(cuentas, f({ q: 'jose perez' }))), [1])
    assert.deepEqual(ids(filtrarCuentas(cuentas, f({ q: 'GOMEZ' }))), [3])
  })
  it('busca por # de cliente exacto', () => {
    assert.deepEqual(ids(filtrarCuentas(cuentas, f({ q: '#7' }))), [2])
    assert.deepEqual(ids(filtrarCuentas(cuentas, f({ q: '5' }))), [4])
  })
  it('busca por DNI, CUIT o teléfono ignorando guiones', () => {
    assert.deepEqual(ids(filtrarCuentas(cuentas, f({ q: '30111222' }))), [1])
    assert.deepEqual(ids(filtrarCuentas(cuentas, f({ q: '30712345679' }))), [2])
    assert.deepEqual(ids(filtrarCuentas(cuentas, f({ q: '5559999' }))), [3])
  })
  it('filtra por saldo', () => {
    assert.deepEqual(ids(filtrarCuentas(cuentas, f({ saldo: 'deuda' }))), [1, 4])
    assert.deepEqual(ids(filtrarCuentas(cuentas, f({ saldo: 'favor' }))), [2])
    assert.deepEqual(ids(filtrarCuentas(cuentas, f({ saldo: 'aldia' }))), [3])
  })
  it('filtra por estado, tipo (sin importar mayúsculas) y operaciones en curso', () => {
    assert.deepEqual(ids(filtrarCuentas(cuentas, f({ estado: 'deshabilitada' }))), [3])
    assert.deepEqual(ids(filtrarCuentas(cuentas, f({ tipo: 'Empresa' }))), [2, 4])
    assert.deepEqual(ids(filtrarCuentas(cuentas, f({ enCurso: 'si' }))), [2, 3])
  })
  it('combina filtros', () => {
    assert.deepEqual(ids(filtrarCuentas(cuentas, f({ tipo: 'Empresa', saldo: 'deuda' }))), [4])
  })
  it('ordena por saldo (más deuda primero) y por cliente', () => {
    assert.deepEqual(ids(filtrarCuentas(cuentas, f({ sort: 'saldo' }))), [4, 1, 3, 2])
    assert.deepEqual(ids(filtrarCuentas(cuentas, f({ sort: 'cliente' }))), [4, 2, 3, 1])
    assert.deepEqual(ids(filtrarCuentas(cuentas, f({ sort: 'movimientos', dir: 'DESC' }))), [2, 1, 4, 3])
  })
})

describe('vista cuentas corrientes con filtros', () => {
  const { renderVista } = require('./helpers/vistas')
  const base = { titulo: 'Cuentas corrientes', sinCuenta: [], totalCuentas: 4, tiposCliente: ['Empresa', 'Particular', 'Obra'], scripts: [] }

  it('muestra buscador, filtros, encabezados ordenables y "Mostrando X de Y"', async () => {
    const filtros = f({ q: 'perez', saldo: 'deuda', sort: 'saldo' })
    const html = await renderVista('pages/clientes/cuentas', { ...base, filtros, conCuenta: filtrarCuentas(cuentas, filtros) })
    assert.match(html, /name="q" value="perez"/)
    assert.match(html, /<option value="deuda" selected>Con deuda/)
    assert.match(html, /href="\?q=perez&amp;saldo=deuda&amp;sort=saldo&amp;dir=DESC"/)
    assert.match(html, /Mostrando 1 de 4/)
    assert.match(html, /Debe \$5\.000/)
    assert.doesNotMatch(html, /FEHUSA/)
  })
  it('sin resultados por filtros ofrece limpiarlos', async () => {
    const html = await renderVista('pages/clientes/cuentas', { ...base, filtros: f({ q: 'nadie' }), conCuenta: [] })
    assert.match(html, /Ninguna cuenta coincide con los filtros/)
    assert.match(html, /Ningún cliente sin cuenta coincide con "nadie"/)
  })
})
