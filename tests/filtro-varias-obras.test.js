'use strict'
// Filtro por obra con VARIAS obras: Cuenta corriente, Liquidaciones, Facturación y Libro de
// ventas traen las operaciones de todas las obras marcadas (ninguna = todas).
// Corre dentro de la transacción de prueba (ROLLBACK al final: nada queda guardado).
const prueba = require('./helpers/db')
const datos = require('./helpers/datos')
const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { PassThrough } = require('stream')
const VentasModel = require('../src/models/ventas.model')
const ClientesModel = require('../src/models/clientes.model')
const LiquidacionesModel = require('../src/models/liquidaciones.model')
const ReportesModel = require('../src/models/reportes.model')
const { normalizarFiltros } = require('../src/utils/liquidaciones')
const { renderVista } = require('./helpers/vistas')

function llamar(ctrl, accion, { query = {}, params = {}, user }) {
  return new Promise((resolve, reject) => {
    const flashes = []
    const req = { query, params, body: {}, session: { user }, flash: (tipo, msg) => flashes.push({ tipo, msg }), get: () => null }
    const res = {
      locals: {}, status() { return this },
      redirect: (url) => resolve({ url, flashes }),
      render: (vista, data) => resolve({ vista, data, flashes }),
    }
    Promise.resolve(ctrl[accion](req, res)).catch(reject)
  })
}

// res simulado para los PDF: un stream que junta los bytes
function resFalso(alTerminar) {
  const s = new PassThrough()
  const partes = []
  s.headers = {}
  s.setHeader = (k, v) => { s.headers[k] = v }
  s.redirect = (url) => alTerminar({ url })
  s.on('data', (c) => partes.push(c))
  s.on('end', () => alTerminar({ pdf: Buffer.concat(partes), headers: s.headers }))
  return s
}

describe('filtro por varias obras', () => {
  let user, cliente, opA, opB, opC, A, B, C

  before(async () => {
    await prueba.abrir()
    const admin = await datos.idAdministrativo()
    user = { id: admin, rol: 'dueno' }
    cliente = await datos.crearCliente({ cuentaCorriente: true })
    const producto = (await prueba.q(`SELECT id FROM productos WHERE COALESCE(es_contenedor,0)=0 ORDER BY id LIMIT 1`)).rows[0].id
    const venta = async (obra, precio) => {
      const id = (await VentasModel.crear({ id_cliente: cliente, id_administrativo: admin, tipo_op: 'M', modalidad: 'flete',
        fecha_emision: '2026-10-05', fecha_entrega_planificada: '2026-10-05', domicilio: { calle: 'Colón', altura: '100' }, obra,
        metodo_pago: 'cuenta_corriente', precio_flete: 0, monto_total: precio,
        detalles: [{ id_producto: producto, cantidad_pedida: 1, precio_unitario: precio }] })).id
      await VentasModel.sincronizarCargoCC(id)
      return String(id)
    }
    opA = await venta('Barrio Norte L1', 1000)
    opB = await venta('Barrio Sur L2', 2000)
    opC = await venta('Centro L3', 4000)
    const obras = await ClientesModel.obras(cliente)
    const clave = (nombre) => obras.find(o => o.nombre === nombre).clave
    A = clave('Barrio Norte L1'); B = clave('Barrio Sur L2'); C = clave('Centro L3')
  })
  after(() => prueba.cerrar())

  it('obrasElegidas: las operaciones de todas las marcadas; ninguna = sin filtro', async () => {
    const dos = await ClientesModel.obrasElegidas(cliente, [A, B])
    assert.deepEqual(dos.claves, [A, B])
    assert.deepEqual(dos.opIds.slice().sort(), [opA, opB].sort())
    assert.equal(dos.nombre, 'Barrio Norte L1, Barrio Sur L2')
    assert.equal(dos.etiqueta, 'Obras')
    assert.deepEqual((await ClientesModel.obrasElegidas(cliente, A)).opIds, [opA])
    assert.equal(await ClientesModel.obrasElegidas(cliente, []), null)
    assert.equal(await ClientesModel.obrasElegidas(cliente, undefined), null)
    // Una clave que ya no existe no suma operaciones (no se cae a "todas")
    const rara = await ClientesModel.obrasElegidas(cliente, ['no existe'])
    assert.deepEqual(rara.opIds, [])
  })

  it('Liquidación: solo las obras marcadas, con resumen por obra y sin pagos', async () => {
    const f = normalizarFiltros({ clienteId: String(cliente), obra: [A, C], desde: '2026-10-01', hasta: '2026-10-31' }, '2026-10-06')
    const r = await LiquidacionesModel.liquidacion(f)
    const c = r.clientes[0]
    assert.deepEqual(c.operaciones.map(o => String(o.id)).sort(), [opA, opC].sort())
    assert.deepEqual(c.porObra.map(o => o.nombre).sort(), ['Barrio Norte L1', 'Centro L3'])
    assert.equal(c.pagos, null)
    assert.equal(r.obraEtiqueta, 'Obras')
    assert.equal(r.obra, 'Barrio Norte L1, Centro L3')
    // Con una sola obra no hay resumen por obra
    const una = await LiquidacionesModel.liquidacion({ ...f, obra: [B] })
    assert.deepEqual(una.clientes[0].operaciones.map(o => String(o.id)), [opB])
    assert.deepEqual(una.clientes[0].porObra, [])
    assert.equal(una.obraEtiqueta, 'Obra')
  })

  it('Liquidaciones (pantalla): las casillas marcadas y el PDF con las dos obras', async () => {
    const Ctrl = require('../src/controllers/liquidaciones.controller')
    const r = await llamar(Ctrl, 'index', { user, query: { clienteId: String(cliente), obra: [A, B], desde: '2026-10-01', hasta: '2026-10-31' } })
    assert.deepEqual(r.data.filtros.obra, [A, B])
    assert.deepEqual(r.data.liquidacion.clientes[0].operaciones.map(o => String(o.id)).sort(), [opA, opB].sort())
    const html = await renderVista('pages/liquidaciones/index', r.data)
    const marcadas = (html.match(/<input type="checkbox" name="obra" value="[^"]*" checked>/g) || []).length
    assert.equal(marcadas, 2)
    assert.match(html, /<span class="filtro-obras__texto">2 obras: Barrio Norte L1, Barrio Sur L2<\/span>/)
    const pdf = html.match(/href="\/liquidaciones\/pdf\?([^"]*)"/)[1]
    assert.deepEqual(new URLSearchParams(pdf.replace(/&amp;/g, '&')).getAll('obra'), [A, B])
  })

  it('Cuenta corriente: movimientos de las obras marcadas y el PDF con las dos', async () => {
    const Ctrl = require('../src/controllers/clientes.controller')
    const r = await llamar(Ctrl, 'cuentaDetalle', { user, params: { id: cliente }, query: { obra: [A, B], desde: '2026-10-01', hasta: '2026-10-31' } })
    assert.equal(r.vista, 'pages/clientes/cuenta_detalle')
    assert.deepEqual(r.data.filtros.obra, [A, B])
    const cargos = r.data.estado.movimientos.filter(m => m.tipo === 'deuda').map(m => String(m.id_op_encabezado))
    assert.deepEqual([...new Set(cargos)].sort(), [opA, opB].sort())
    assert.equal(r.data.resumenOps.cantidad, 2)
    const html = await renderVista('pages/clientes/cuenta_detalle', r.data)
    assert.equal((html.match(/name="obra" value="[^"]*" checked/g) || []).length, 2)
    assert.match(html, /con las obras <strong>Barrio Norte L1, Barrio Sur L2<\/strong>/)
    const pdf = html.match(/href="\/clientes\/cuentas\/\d+\/pdf\?([^"]*)"/)[1]
    assert.deepEqual(new URLSearchParams(pdf.replace(/&amp;/g, '&')).getAll('obra'), [A, B])
  })

  it('Facturación: el filtro lee las dos obras y las pestañas las conservan', async () => {
    const Ctrl = require('../src/controllers/facturacion.controller')
    const r = await llamar(Ctrl, 'index', { user, query: { clienteId: String(cliente), obra: [A, B] } })
    assert.equal(r.vista, 'pages/facturacion/index')
    assert.deepEqual(r.data.filtros.obra, [A, B])
    const html = await renderVista('pages/facturacion/index', r.data)
    const tab = html.match(/href="(\/facturacion\?tab=facturado[^"]*)"/)[1].replace(/&amp;/g, '&')
    assert.deepEqual(new URLSearchParams(tab.split('?')[1]).getAll('obra'), [A, B])
    assert.equal((html.match(/name="obra" value="[^"]*" checked/g) || []).length, 2)
  })

  it('Libro de ventas: solo las ventas de las obras marcadas; el PDF se genera', async () => {
    const obras = await ClientesModel.obrasElegidas(cliente, [B, C])
    const { filas } = await ReportesModel.libroVentas({ clienteId: cliente, opIds: obras.opIds })
    assert.deepEqual([...new Set(filas.map(f => f.obra))].sort(), ['Barrio Sur L2', 'Centro L3'])
    const Ctrl = require('../src/controllers/ventas.controller')
    const fin = await new Promise((resolve, reject) => {
      const req = { query: { clienteId: String(cliente), obra: [B, C] }, flash: () => {}, session: { user } }
      Promise.resolve(Ctrl.libroPDF(req, resFalso(resolve))).catch(reject)
    })
    assert.equal(fin.url, undefined)
    assert.equal(fin.headers['Content-Type'], 'application/pdf')
    assert.ok(fin.pdf.length > 1000)
  })
})
