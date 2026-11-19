'use strict'
// Descuentos contra la base, dentro de la transacción de prueba (ROLLBACK al final).
const prueba = require('./helpers/db')
const datos = require('./helpers/datos')
const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const VentasModel = require('../src/models/ventas.model')
const ClientesModel = require('../src/models/clientes.model')
const TransaccionesModel = require('../src/models/transacciones.model')
const LiquidacionesModel = require('../src/models/liquidaciones.model')
const DescuentosModel = require('../src/models/descuentos.model')
const { normalizarFiltros } = require('../src/utils/liquidaciones')

const filtros = (extra = {}) => normalizarFiltros({ desde: '2026-11-01', hasta: '2026-11-30', ...extra }, '2026-11-19')

describe('DescuentosModel', () => {
  let cliente, otro, admin, producto, A, B, C, Dv

  const venta = async ({ metodo, total, remito, dia }) => {
    const id = (await VentasModel.crear({
      id_cliente: cliente, id_administrativo: admin, tipo_op: 'M', modalidad: 'flete', metodo_pago: metodo,
      fecha_emision: `2026-11-0${dia}`, fecha_entrega_planificada: `2026-11-0${dia}`, domicilio: { calle: 'Colón', altura: '100' }, obra: null,
      precio_flete: 0, monto_total: total, detalles: [{ id_producto: producto, cantidad_pedida: 1, precio_unitario: total }],
    })).id
    await prueba.q(`UPDATE op_encabezado SET nro_remito = ?, estado = 'entregado' WHERE id = ?`, [remito, id])
    await VentasModel.sincronizarCargoCC(id)
    return id
  }
  const opDe = async (id) => (await LiquidacionesModel.operacionesCliente(cliente)).find(o => String(o.id) === String(id))
  const saldoCuenta = async () => Number((await prueba.q(`SELECT saldo FROM clientes WHERE id = ?`, [cliente])).rows[0].saldo)
  const f = () => filtros({ clienteId: String(cliente) })

  before(async () => {
    await prueba.abrir()
    admin = await datos.idAdministrativo()
    cliente = await datos.crearCliente({ cuentaCorriente: true })
    otro = await datos.crearCliente({ cuentaCorriente: true })
    producto = (await prueba.q(`SELECT id FROM productos WHERE COALESCE(es_contenedor,0)=0 ORDER BY id LIMIT 1`)).rows[0].id
    A = await venta({ metodo: 'cuenta_corriente', total: 1000, remito: 71001, dia: 2 })
    B = await venta({ metodo: 'cuenta_corriente', total: 500, remito: 71001, dia: 3 })
    C = await venta({ metodo: 'efectivo', total: 800, remito: 71002, dia: 4 })
    Dv = await venta({ metodo: 'cuenta_corriente', total: 300, remito: 71003, dia: 5 })
    await prueba.q(`UPDATE op_encabezado SET facturado = 1, nro_factura = 'F-1' WHERE id = ?`, [Dv])
    // Pago de 400: va a lo más viejo (A)
    await ClientesModel.agregarMovimiento(cliente, { tipo: 'pago', descripcion: 'Pago prueba', monto: 400, metodo_pago: 'transferencia', fecha: '2026-11-06 10:00:00' })
  })
  after(() => prueba.cerrar())

  it('opciones: operaciones en pantalla, remitos, facturas y lo que debe en total', async () => {
    const o = await DescuentosModel.opciones(cliente, f())
    assert.deepEqual(o.enPantalla.map(x => String(x.id)).sort(), [A, B, C, Dv].map(String).sort())
    assert.deepEqual(o.remitos.map(r => [r.numero, r.cantidad, r.resta]), [['71001', 2, 1100], ['71002', 1, 800], ['71003', 1, 300]])
    assert.deepEqual(o.facturas.map(r => r.numero), ['F-1'])
    assert.equal(o.saldoTotal, 600 + 500 + 300 + 800)
    assert.match(o.enPantalla.find(x => String(x.id) === String(Dv)).aviso, /Tiene factura emitida \(N° F-1\)/)
  })

  it('vista previa por remito: 10% de lo que falta pagar de cada una', async () => {
    const v = await DescuentosModel.vistaPrevia(cliente, { tipo: 'porcentaje', valor: '10', alcance: 'remito', referencia: '71001' }, f())
    assert.deepEqual(v.lineas.map(l => [String(l.id), l.resta, l.monto, l.queda]), [[String(A), 600, 60, 540], [String(B), 500, 50, 450]])
    assert.equal(v.total, 110)
  })

  it('aplicar con la vista previa vieja (importe distinto): se rechaza', async () => {
    await assert.rejects(DescuentosModel.aplicar(cliente, { tipo: 'porcentaje', valor: '10', alcance: 'remito', referencia: '71001' }, f(), { totalEsperado: 999 }), /cambiaron/)
  })

  it('monto mayor a lo que debe: se rechaza', async () => {
    await assert.rejects(DescuentosModel.vistaPrevia(cliente, { tipo: 'monto', valor: '5000', alcance: 'remito', referencia: '71001' }, f()), /más de lo que debe/)
  })

  let porRemito
  it('aplicar por remito (cuenta corriente): baja el saldo, renglón de descuento y sin diferencias', async () => {
    const antes = await saldoCuenta()
    porRemito = await DescuentosModel.aplicar(cliente, { tipo: 'porcentaje', valor: '10', alcance: 'remito', referencia: '71001' }, f(), { usuario: admin, motivo: 'cliente fiel', totalEsperado: 110 })
    assert.equal(r2(await saldoCuenta() - antes), 110)
    const a = await opDe(A)
    assert.deepEqual([a.total, a.pagado, a.resta, a.estado], [940, 400, 540, 'parcial'])
    assert.ok(a.renglones.some(r => r.esDescuento && r.importe === -60 && /^Descuento 10% \(\d\d\/\d\d\/\d{4}\)$/.test(r.descripcion)))
    assert.ok(!a.renglones.some(r => /Diferencia/.test(r.descripcion)))
    const b = await opDe(B)
    assert.deepEqual([b.total, b.resta], [450, 450])
    const s = await LiquidacionesModel.saldoCliente(cliente)
    assert.equal(s.cuenta.coincideConMovimientos, true)
    assert.equal(s.cuenta.aFavor, 0)
  })

  it('aplicar a una de contado: baja lo que falta cobrar, sin movimiento en la cuenta; cobrarla cobra lo descontado', async () => {
    const antes = await saldoCuenta()
    await DescuentosModel.aplicar(cliente, { tipo: 'monto', valor: '100', alcance: 'operacion', referencia: String(C) }, f(), { usuario: admin })
    assert.equal(await saldoCuenta(), antes)
    const c = await opDe(C)
    assert.deepEqual([c.total, c.resta], [700, 700])
    const est = await LiquidacionesModel.estadosPago([C])
    assert.equal(est[C].resta, 700)
    assert.equal(est[C].acciones.pagada, true)
  })

  it('por factura: el aviso de factura emitida queda guardado', async () => {
    const v = await DescuentosModel.vistaPrevia(cliente, { tipo: 'porcentaje', valor: '50', alcance: 'factura', referencia: 'F-1' }, f())
    assert.match(v.lineas[0].aviso, /requiere una nota de crédito por fuera del sistema/)
    await DescuentosModel.aplicar(cliente, { tipo: 'porcentaje', valor: '50', alcance: 'factura', referencia: 'F-1' }, f(), { usuario: admin })
    assert.equal((await opDe(Dv)).resta, 150)
  })

  it('sobre el saldo total: ajuste sin operación que baja lo que debe', async () => {
    const antes = (await LiquidacionesModel.saldoCliente(cliente)).total
    await DescuentosModel.aplicar(cliente, { tipo: 'monto', valor: '100', alcance: 'saldo' }, f(), { usuario: admin })
    assert.equal(r2(antes - (await LiquidacionesModel.saldoCliente(cliente)).total), 100)
    const liq = await LiquidacionesModel.liquidacion(f())
    assert.equal(liq.descuentosSaldo.length, 1)
    assert.equal(liq.descuentosSaldo[0].monto, 100)
  })

  it('delCliente: del más nuevo al más viejo, con operaciones y aviso', async () => {
    const lista = await DescuentosModel.delCliente(cliente)
    assert.deepEqual(lista.map(d => d.alcance), ['saldo', 'factura', 'operacion', 'remito'])
    const rem = lista.find(d => d.alcance === 'remito')
    assert.equal(rem.alcanceTexto, 'Remito 71001')
    assert.equal(rem.motivo, 'cliente fiel')
    assert.deepEqual(rem.operaciones.map(o => o.monto), [60, 50])
    assert.ok(lista.find(d => d.alcance === 'factura').aviso)
    assert.equal(await DescuentosModel.cantidadVigentes(cliente), 4)
  })

  it('revertir: deja todo como antes; dos veces o de otro cliente, error', async () => {
    const antes = await saldoCuenta()
    await assert.rejects(DescuentosModel.revertir(porRemito.id, otro, { usuario: admin, motivo: 'x' }), /no existe/)
    await assert.rejects(DescuentosModel.revertir(porRemito.id, cliente, { usuario: admin, motivo: '' }), /motivo/)
    await DescuentosModel.revertir(porRemito.id, cliente, { usuario: admin, motivo: 'error de carga' })
    assert.equal(r2(antes - await saldoCuenta()), 110)
    // El descuento de 100 "sobre el saldo" (vigente) se aplica a lo más viejo: A
    const a = await opDe(A)
    assert.deepEqual([a.total, a.resta], [1000, 500])
    assert.ok(!a.renglones.some(r => r.esDescuento))
    await assert.rejects(DescuentosModel.revertir(porRemito.id, cliente, { usuario: admin, motivo: 'otra vez' }), /ya estaba revertido/)
    const rev = (await DescuentosModel.delCliente(cliente)).find(d => d.id === porRemito.id || String(d.id) === String(porRemito.id))
    assert.equal(rev.revertido, true)
    assert.equal(rev.revertidoMotivo, 'error de carga')
  })

  it('cobrada con descuento y después revertido: vuelve a deber la diferencia', async () => {
    await TransaccionesModel.crear({ tipo: 'Venta Viaje', id_op_encabezado: C, cliente_id: cliente, cliente: 'PRUEBA',
      monto: 700, descripcion: 'prueba', metodo_pago: 'efectivo', fecha: '2026-11-10' })
    assert.equal((await opDe(C)).estado, 'pagada')
    const d = (await DescuentosModel.delCliente(cliente)).find(x => x.alcance === 'operacion')
    await DescuentosModel.revertir(d.id, cliente, { usuario: admin, motivo: 'no correspondía' })
    const c = await opDe(C)
    assert.deepEqual([c.estado, c.resta], ['parcial', 100])
  })

  it('una operación descontada que se anula: el ajuste se anula con el cargo (no queda crédito suelto)', async () => {
    const v = await DescuentosModel.aplicar(cliente, { tipo: 'monto', valor: '50', alcance: 'operacion', referencia: String(B) }, f(), { usuario: admin })
    assert.ok(v.id)
    await prueba.q(`UPDATE op_encabezado SET estado = 'anulado' WHERE id = ?`, [B])
    await VentasModel.sincronizarCargoCC(B)
    const vivos = (await prueba.q(`SELECT COUNT(*) AS n FROM movimientos_cuenta WHERE id_op_encabezado = ? AND COALESCE(anulado, 0) = 0`, [B])).rows[0].n
    assert.equal(Number(vivos), 0)
    const s = await LiquidacionesModel.saldoCliente(cliente)
    assert.equal(s.cuenta.coincideConMovimientos, true)
  })

  it('editar una venta descontada (re-sincronizar el cargo) no pisa el descuento', async () => {
    await DescuentosModel.aplicar(cliente, { tipo: 'monto', valor: '100', alcance: 'operacion', referencia: String(A) }, f(), { usuario: admin })
    await VentasModel.sincronizarCargoCC(A)
    await VentasModel.sincronizarCargoCC(A)
    const a = await opDe(A)
    assert.deepEqual([a.total, a.resta], [900, 400])   // − pago 400 − descuento sobre el saldo 100
    const ajustes = (await prueba.q(`SELECT COUNT(*) AS n FROM movimientos_cuenta WHERE id_op_encabezado = ? AND tipo = 'ajuste' AND COALESCE(anulado, 0) = 0`, [A])).rows[0].n
    assert.equal(Number(ajustes), 1)
  })
})

function r2(n) { return Math.round(n * 100) / 100 }
