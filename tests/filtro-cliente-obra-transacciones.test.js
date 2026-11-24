'use strict'
// Transacciones filtra por cliente y por una o varias obras, con el mismo componente que
// Liquidaciones: la tabla, las tarjetas, los botones por tipo y el reporte PDF/Excel usan el
// mismo filtro. Corre dentro de la transacción de prueba (ROLLBACK al final).
const prueba = require('./helpers/db')
const datos = require('./helpers/datos')
const { renderVista } = require('./helpers/vistas')
const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { PassThrough } = require('node:stream')
const ExcelJS = require('exceljs')
const VentasModel = require('../src/models/ventas.model')
const ClientesModel = require('../src/models/clientes.model')
const TransaccionesModel = require('../src/models/transacciones.model')
const MovimientosDineroModel = require('../src/models/movimientosDinero.model')
const Transacciones = require('../src/controllers/transacciones.controller')
const { consulta } = require('../src/utils/consulta')

function llamar(Controller, accion, { query = {}, params = {} } = {}) {
  return new Promise((resolve, reject) => {
    const flashes = []
    const req = { body: {}, params, query, session: { user: { id: 1, rol: 'dueno', nombre: 'Prueba' } }, flash: (t, m) => flashes.push({ t, m }), get: () => '' }
    const res = {
      redirect: (url) => resolve({ url, flashes }),
      render: (vista, data) => resolve({ vista, data, flashes }),
      json: (data) => resolve({ json: data, flashes }),
      status() { return this },
    }
    Promise.resolve(Controller[accion](req, res)).catch(reject)
  })
}
// res simulado para los reportes: un stream que junta los bytes
function exportar(query, formato = 'excel') {
  return new Promise((resolve, reject) => {
    const s = new PassThrough()
    const partes = []
    s.headers = {}
    s.setHeader = (k, v) => { s.headers[k] = v }
    s.redirect = (url) => resolve({ url })
    s.on('data', (c) => partes.push(c))
    s.on('end', () => resolve({ bytes: Buffer.concat(partes), headers: s.headers }))
    const req = { params: { formato }, query, flash: () => {}, session: { user: { id: 1, rol: 'dueno' } } }
    Promise.resolve(Transacciones.exportar(req, s)).catch(reject)
  })
}
const user = { rol: 'dueno', nombre: 'Prueba' }
const ids = (filas) => filas.map(f => String(f.id)).sort()

// ── Datos: un cliente con tres ventas cobradas en tres obras + un pago, y otro cliente ───
let cliente, otro, opA, opB, opC, txA, txB, txC, txOtro, idPago, A, B, C
const rango = { preset: 'rango', fechaDesde: '2026-11-01', fechaHasta: '2026-11-30' }

before(async () => {
  await prueba.abrir()
  const admin = await datos.idAdministrativo()
  cliente = await datos.crearCliente({ cuentaCorriente: true })
  otro = await datos.crearCliente({ cuentaCorriente: true })
  const producto = (await prueba.q(`SELECT id FROM productos WHERE COALESCE(es_contenedor,0)=0 ORDER BY id LIMIT 1`)).rows[0].id
  const venta = async (id_cliente, obra, precio) => {
    const op = String((await VentasModel.crear({ id_cliente, id_administrativo: admin, tipo_op: 'M', modalidad: 'flete',
      fecha_emision: '2026-11-05', fecha_entrega_planificada: '2026-11-05', domicilio: { calle: 'Colón', altura: '100' }, obra,
      metodo_pago: 'efectivo', precio_flete: 0, monto_total: precio,
      detalles: [{ id_producto: producto, cantidad_pedida: 1, precio_unitario: precio }] })).id)
    const tx = String(await TransaccionesModel.crear({ tipo: 'Venta Viaje', id_op_encabezado: op, cliente_id: id_cliente, cliente: 'PRUEBA',
      monto: precio, metodo_pago: 'efectivo', fecha: '2026-11-05' }))
    return { op, tx }
  }
  ;({ op: opA, tx: txA } = await venta(cliente, 'Barrio Norte L1', 1000))
  ;({ op: opB, tx: txB } = await venta(cliente, 'Barrio Sur L2', 2000))
  ;({ op: opC, tx: txC } = await venta(cliente, 'Centro L3', 4000))
  ;({ tx: txOtro } = await venta(otro, 'Barrio Norte L1', 8000))
  await ClientesModel.agregarMovimiento(cliente, { tipo: 'pago', descripcion: 'Pago', monto: 500, metodo_pago: 'transferencia', fecha: '2026-11-06 10:00:00' })
  const obras = await ClientesModel.obras(cliente)
  const clave = (nombre) => obras.find(o => o.nombre === nombre).clave
  A = clave('Barrio Norte L1'); B = clave('Barrio Sur L2'); C = clave('Centro L3')
})
after(() => prueba.cerrar())

const cobros = (filas) => filas.filter(f => f.origen === 'transaccion')
const pagos = (filas) => filas.filter(f => f.origen === 'pago_cliente')

describe('MovimientosDineroModel: filtro por operaciones (opIds)', () => {
  it('con cliente y opIds: solo los cobros de esas obras y ningún pago de cliente', async () => {
    const r = await MovimientosDineroModel.listar({ clienteId: cliente, opIds: [opA, opB], limit: 50 })
    assert.deepEqual(ids(cobros(r.rows)), [txA, txB].sort())
    assert.equal(pagos(r.rows).length, 0)
    assert.equal(r.rows.length, 2)
  })

  it('con solo el cliente: sus tres cobros y el pago', async () => {
    const r = await MovimientosDineroModel.listar({ clienteId: cliente, limit: 50 })
    assert.deepEqual(ids(cobros(r.rows)), [txA, txB, txC].sort())
    assert.equal(pagos(r.rows).length, 1)
  })

  it('opIds vacío no deja ninguno (no cae a "todos")', async () => {
    const r = await MovimientosDineroModel.listar({ clienteId: cliente, opIds: [], limit: 50 })
    assert.equal(r.total, 0)
  })

  it('las tarjetas y los botones cuentan lo mismo que la tabla', async () => {
    const r = await MovimientosDineroModel.resumen({ clienteId: cliente, opIds: [opA] })
    assert.equal(r.conteo.ventas, 1)
    assert.equal(r.entradas, 1000)
  })

  it('el reporte (todos) usa el mismo filtro', async () => {
    const filas = await MovimientosDineroModel.todos({ clienteId: cliente, opIds: [opA, opC] })
    assert.deepEqual(ids(filas), [txA, txC].sort())
  })
})

describe('Transacciones: pantalla con cliente y obras', () => {
  it('cliente + dos obras: tabla, tarjetas y componente con lo elegido', async () => {
    const { data } = await llamar(Transacciones, 'index', { query: { ...rango, clienteId: String(cliente), obra: [A, B] } })
    assert.deepEqual(ids(cobros(data.movimientos)), [txA, txB].sort())
    assert.equal(pagos(data.movimientos).length, 0)
    assert.equal(data.metricas.entradas, 3000)
    assert.equal(String(data.clienteSel.id), String(cliente))
    assert.equal(data.obras.length, 3)
    assert.deepEqual(data.filtros.obra, [A, B])
    assert.equal(String(data.filtros.clienteId), String(cliente))
    assert.equal(data.clientesLista, undefined)
  })

  it('solo el cliente: incluye sus cobros y el pago de cliente', async () => {
    const { data } = await llamar(Transacciones, 'index', { query: { ...rango, clienteId: String(cliente) } })
    assert.deepEqual(ids(cobros(data.movimientos)), [txA, txB, txC].sort())
    assert.equal(pagos(data.movimientos).length, 1)
    assert.equal(data.movimientos.every(m => m.cliente_id == null || String(m.cliente_id) === String(cliente)), true)
  })

  it('un enlace viejo con idCliente sigue filtrando', async () => {
    const { data } = await llamar(Transacciones, 'index', { query: { ...rango, idCliente: String(cliente) } })
    assert.equal(String(data.filtros.clienteId), String(cliente))
    assert.deepEqual(ids(cobros(data.movimientos)), [txA, txB, txC].sort())
  })

  it('un cliente que no existe se ignora (no rompe ni filtra)', async () => {
    const { data } = await llamar(Transacciones, 'index', { query: { ...rango, clienteId: '999999999' } })
    assert.equal(data.clienteSel, null)
    assert.equal(data.filtros.clienteId, '')
    assert.ok(ids(cobros(data.movimientos)).includes(txOtro))
  })

  it('una obra sin cliente se ignora', async () => {
    const { data } = await llamar(Transacciones, 'index', { query: { ...rango, obra: [A] } })
    assert.deepEqual(data.filtros.obra, [])
    assert.ok(ids(cobros(data.movimientos)).includes(txOtro))
  })

  it('una obra que ya no existe da lista vacía (no "todas las obras")', async () => {
    const { data } = await llamar(Transacciones, 'index', { query: { ...rango, clienteId: String(cliente), obra: ['no existe'] } })
    assert.equal(data.movimientos.length, 0)
  })

  it('el texto libre (Empleado / proveedor) sigue filtrando por nombre, sin depender del cliente elegido', async () => {
    const { data } = await llamar(Transacciones, 'index', { query: { ...rango, cliente: 'PRUEBA' } })
    assert.ok(cobros(data.movimientos).length >= 4)
    assert.ok(cobros(data.movimientos).every(m => /PRUEBA/i.test(m.persona)))
    assert.equal(data.clienteSel, null)
  })
})

describe('Transacciones: el reporte usa los mismos filtros', () => {
  it('Excel: dice el cliente y las obras, y trae solo esas filas', async () => {
    const { bytes } = await exportar({ ...rango, clienteId: String(cliente), obra: [A, B] })
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(bytes)
    const hoja = wb.worksheets[0]
    const titulo = String(hoja.getCell(1, 1).value)
    const nombre = ClientesModel.nombreCompleto(await ClientesModel.obtener(String(cliente)))
    assert.ok(titulo.includes(`Cliente: ${nombre}`), titulo)
    assert.ok(titulo.includes('Obras: Barrio Norte L1, Barrio Sur L2'), titulo)
    assert.ok(!titulo.includes('Cliente / persona:'), titulo)
    const codigos = []
    hoja.eachRow((row, n) => { if (n > 2) { const c = String(row.getCell(1).value || ''); if (/^[A-Z]{3}-\d+$/.test(c)) codigos.push(c) } })
    const filasTx = (await prueba.q(`SELECT tipo, numero FROM transacciones WHERE id IN (?, ?)`, [txA, txB])).rows
    const esperados = filasTx.map(t => TransaccionesModel.codigo(t)).sort()
    assert.deepEqual(codigos.sort(), esperados)
  })

  it('PDF: se genera con los mismos filtros', async () => {
    const r = await exportar({ ...rango, clienteId: String(cliente), obra: [B, C] }, 'pdf')
    assert.equal(r.url, undefined)
    assert.equal(r.headers['Content-Type'], 'application/pdf')
    assert.ok(r.bytes.length > 1000)
  })
})

describe('Transacciones: la vista usa el componente compartido', () => {
  let html
  before(async () => {
    const { data } = await llamar(Transacciones, 'index', { query: { ...rango, clienteId: String(cliente), obra: [A, B] } })
    html = (await renderVista('pages/transacciones/index', { ...data, user })).replace(/&amp;/g, '&')
  })

  it('muestra el buscador de cliente y el desplegable de obras con lo elegido', () => {
    assert.ok(html.includes('data-filtro-obras data-dinamico'))
    assert.ok(html.includes(`<input type="hidden" name="clienteId" id="inputClienteId" value="${cliente}">`))
    const marcadas = html.match(/<input type="checkbox" name="obra" value="[^"]*" checked>/g) || []
    assert.deepEqual(marcadas.map(m => m.match(/value="([^"]*)"/)[1]).sort(), [A, B].sort())
  })

  it('el texto libre se llama Empleado / proveedor y ya no ofrece la lista de clientes', () => {
    assert.ok(html.includes('Empleado / proveedor'))
    assert.ok(!html.includes('listaClientesTx'))
    assert.ok(html.includes('name="cliente"'))
  })

  it('al pasar de página conserva cliente y todas las obras (cada una como su propio parámetro)', async () => {
    const { data } = await llamar(Transacciones, 'index', { query: { ...rango, clienteId: String(cliente), obra: [A, B] } })
    const pag = (await renderVista('pages/transacciones/index', { ...data, totalPaginas: 3, user })).replace(/&amp;/g, '&')
    const sig = (pag.match(/href="(\/transacciones\?[^"]*page=2)"/) || [])[1]
    assert.ok(sig, 'falta el enlace a la página 2')
    assert.ok(sig.includes(consulta({ clienteId: String(cliente), obra: [A, B] })), sig)
  })

  it('los botones por tipo, el período y el reporte conservan cliente y todas las obras', () => {
    const resto = consulta({ clienteId: String(cliente), obra: [A, B] })
    const href = (re) => (html.match(re) || [])[1]
    assert.ok(href(/href="(\/transacciones\?[^"]*categoria=ventas[^"]*)"/).includes(resto), 'botón por tipo')
    assert.ok(href(/href="(\/transacciones\?[^"]*preset=hoy[^"]*)"/).includes(resto), 'chip Hoy')
    assert.ok(href(/href="(\/transacciones\/export\/excel\?[^"]*)"/).includes(resto), 'Excel')
    assert.ok(href(/href="(\/transacciones\/export\/pdf\?[^"]*)"/).includes(resto), 'PDF')
  })
})
