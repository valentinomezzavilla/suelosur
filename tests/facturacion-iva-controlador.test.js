'use strict'
// Controladores con IVA para facturar: el alta de una venta cobra neto + IVA, Facturación
// registra la factura con neto e IVA por operación y genera los PDF de detalle.
// Corre dentro de la transacción de prueba (ROLLBACK al final: nada queda guardado).
const prueba = require('./helpers/db')
const datos = require('./helpers/datos')
const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { PassThrough } = require('stream')
const VentasController = require('../src/controllers/ventas.controller')
const FacturacionController = require('../src/controllers/facturacion.controller')

// req/res mínimos. El res es un stream (el PDF se escribe con pipe) que también redirige y renderiza.
function llamar(Controller, accion, { body = {}, params = {}, query = {}, user }) {
  return new Promise((resolve, reject) => {
    const flashes = []
    const req = { body, params, query, session: { user }, flash: (tipo, msg) => flashes.push({ tipo, msg }) }
    const res = new PassThrough()
    const partes = []
    res.headers = {}
    res.setHeader = (k, v) => { res.headers[k] = v }
    res.on('data', (c) => partes.push(c))
    res.on('end', () => resolve({ pdf: Buffer.concat(partes), headers: res.headers, flashes }))
    res.redirect = (url) => resolve({ url, flashes })
    res.render = (vista, data) => resolve({ vista, data, flashes })
    res.status = () => res
    Promise.resolve(Controller[accion](req, res)).catch(reject)
  })
}

describe('controladores con IVA para facturar', () => {
  let user, producto, precio

  before(async () => {
    await prueba.abrir()
    user = { id: await datos.idAdministrativo(), rol: 'dueno' }
    const p = (await prueba.q(`
      SELECT p.id, p.precio_cantera FROM productos p
      WHERE COALESCE(p.es_contenedor, 0) = 0 AND COALESCE(p.depende_stock, 1) = 0 AND p.activo = 1 AND p.precio_cantera > 0
      ORDER BY p.id LIMIT 1`)).rows[0]
      || (await prueba.q(`INSERT INTO productos (nombre, unidad_medida, precio_cantera, precio_viaje, activo, depende_stock)
           VALUES ('Arena prueba IVA', 'm³', 1000, 1200, 1, 0) RETURNING id, precio_cantera`)).rows[0]
    producto = p.id
    precio = Number(p.precio_cantera)
  })
  after(() => prueba.cerrar())

  const ventaCantera = async (cliente, extra = {}) => {
    const r = await llamar(VentasController, 'finalizarCantera', { user, body: {
      clienteId: String(cliente), clienteNombre: 'PRUEBA', metodoPago: 'efectivo',
      items: JSON.stringify([{ id: producto, cantidad: 2 }]), ...extra,
    } })
    assert.ok(!r.flashes.some(f => f.tipo === 'error'), JSON.stringify(r.flashes))
    return (await prueba.q(`SELECT id FROM op_encabezado WHERE id_cliente = ? ORDER BY id DESC LIMIT 1`, [cliente])).rows[0].id
  }
  const txs = async (id) => (await prueba.q(`SELECT monto FROM transacciones WHERE id_op_encabezado = ?`, [id])).rows.map(r => Number(r.monto))

  it('venta en cantera para facturar: el cobro del alta es neto + 21%', async () => {
    const cli = await datos.crearCliente()
    const id = await ventaCantera(cli, { paraFacturar: '1' })
    const neto = precio * 2
    assert.deepEqual(await txs(id), [Math.round(neto * 121) / 100])
    const op = (await prueba.q(`SELECT para_facturar, iva_alicuota FROM op_encabezado WHERE id = ?`, [id])).rows[0]
    assert.deepEqual([op.para_facturar, op.iva_alicuota], [1, 21])
  })

  it('venta en cantera sin tildar: el cobro es el neto', async () => {
    const cli = await datos.crearCliente()
    const id = await ventaCantera(cli)
    assert.deepEqual(await txs(id), [precio * 2])
  })

  it('Facturación lista neto, IVA y total; facturar guarda neto e IVA; los PDF se generan', async () => {
    const cli = await datos.crearCliente()
    const a = await ventaCantera(cli, { paraFacturar: '1' })
    const b = await ventaCantera(cli, { paraFacturar: '1' })
    const neto = precio * 2

    const vista = await llamar(FacturacionController, 'index', { user, query: { tab: 'pendiente' } })
    const filas = vista.data.lista.filter(o => [a, b].map(String).includes(String(o.id)))
    assert.equal(filas.length, 2)
    filas.forEach(o => assert.deepEqual([o.neto, o.iva, o.monto], [neto, Math.round(neto * 21) / 100, Math.round(neto * 121) / 100]))

    // PDF de la selección (pendiente)
    const pdf = await llamar(FacturacionController, 'pdf', { user, query: { ops: `${a},${b}` } })
    assert.equal(pdf.pdf.subarray(0, 5).toString(), '%PDF-')
    assert.match(pdf.headers['Content-Disposition'], /detalle-facturar-/)

    // Facturar las dos juntas (manual)
    const r = await llamar(FacturacionController, 'facturar', { user, body: {
      op_ids: `${a},${b}`, condicion_iva: 'CF', tipo_comprobante: 'B', modo: 'manual', numero: '0001-00000099', fecha: '2026-10-22',
    } })
    assert.ok(r.flashes.some(f => f.tipo === 'success'), JSON.stringify(r.flashes))
    const f = (await prueba.q(`SELECT neto, iva, total, alicuota_iva FROM facturas WHERE numero = '0001-00000099'`)).rows[0]
    assert.deepEqual([Number(f.neto), Number(f.iva), Number(f.total), Number(f.alicuota_iva)],
      [neto * 2, Math.round(neto * 2 * 21) / 100, Math.round(neto * 2 * 121) / 100, 21])

    // PDF de la factura registrada
    const pf = await llamar(FacturacionController, 'pdfFactura', { user, params: { id: String(a) } })
    assert.equal(pf.pdf.subarray(0, 5).toString(), '%PDF-')
    assert.match(pf.headers['Content-Disposition'], /factura-b-0001-00000099-/)
  })

  it('PDF de operaciones de dos clientes distintos: se rechaza con un aviso', async () => {
    const a = await ventaCantera(await datos.crearCliente(), { paraFacturar: '1' })
    const b = await ventaCantera(await datos.crearCliente(), { paraFacturar: '1' })
    const r = await llamar(FacturacionController, 'pdf', { user, query: { ops: `${a},${b}` } })
    assert.equal(r.url, '/facturacion?tab=pendiente')
    assert.ok(r.flashes.some(f => f.tipo === 'error' && /mismo cliente/.test(f.msg)))
  })
})
