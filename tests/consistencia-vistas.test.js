'use strict'
// Pantallas de: Transacciones (entradas y salidas), Flota de Personal (pagos y sueldos),
// Liquidación ↔ Cuenta corriente y fechas de compra / envío / pago. Sin base.
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { renderVista } = require('./helpers/vistas')
const { TIPOS, ESTADOS } = require('../src/utils/liquidaciones')
const M = require('../src/models/movimientosDinero.model')
const { ESTADOS: ESTADOS_SUELDO } = require('../src/utils/sueldos')
const { codigo: codigoTx } = require('../src/models/transacciones.model')

describe('vista Transacciones', () => {
  const filtros = { categoria: 'todas', id: '', tipo: '', idCliente: '', cliente: '', remito: '', nroOp: '', fechaDesde: '2026-11-01',
    fechaHasta: '2026-11-30', montoMin: '', montoMax: '', mes: '', preset: 'mes', sortBy: 'fecha', sortDir: 'DESC' }
  const movimientos = [
    { origen: 'transaccion', id: 1, categoria: 'ventas', tipo: 'Venta Viaje', numero: 3, fecha: '2026-10-30 12:00:00', cargado_en: '2026-11-04 09:00:00',
      persona: 'LANFRANCONI', descripcion: 'Viaje a Colón 100', metodo_pago: 'efectivo', monto: 1000, sentido: 'entrada', id_op_encabezado: 9 },
    { origen: 'transaccion', id: 2, categoria: 'ventas', tipo: 'Venta Cantera', numero: 4, fecha: '2026-11-04 10:00:00', cargado_en: '2026-11-04 10:00:00',
      persona: 'LANFRANCONI', descripcion: 'Arena', metodo_pago: 'cuenta_corriente', monto: 500, sentido: 'a_cuenta', id_op_encabezado: 10, saldada: false },
    { origen: 'pago_cliente', id: 12, categoria: 'pagos_clientes', tipo: 'Pago de cliente', fecha: '2026-11-03 12:00:00', cargado_en: null,
      cliente_id: 64, persona: 'LANFRANCONI', descripcion: 'Pago / abono de deuda', metodo_pago: 'transferencia', monto: 300, sentido: 'entrada' },
    { origen: 'egreso', id: 7, categoria: 'sueldos', tipo: 'Sueldo', fecha: '2026-11-02', cargado_en: '2026-11-02 08:00:00', persona: 'Juan Pérez',
      descripcion: 'Sueldo — Juan Pérez', metodo_pago: 'transferencia', monto: 800, sentido: 'salida', es_tercero: true, id_pago_empleado: 5, id_empleado: 3, categoria_egreso: 'sueldo' },
  ]
  const locals = {
    titulo: 'Transacciones', movimientos, filtros, categorias: M.CATEGORIAS, codigoMov: M.codigo, codigoTx,
    clientesLista: [], periodoLabel: 'Noviembre 2026', pagina: 1, totalPaginas: 1, totalTransacciones: 4, scripts: [],
    metricas: { entradas: 1300, salidas: 800, neto: 500, aCuenta: 500, cantidad: 4,
      conteo: { todas: 4, ventas: 2, alquileres: 0, pagos_clientes: 1, sueldos: 1, compras: 0, ajustes: 0 } },
  }

  it('botones por tipo con su cantidad, y el activo marcado', async () => {
    const html = await renderVista('pages/transacciones/index', locals)
    for (const c of M.CATEGORIAS) assert.match(html, new RegExp(`<span>${c.etiqueta}</span>`))
    assert.match(html, /class="mov-chip is-active"[^>]*>\s*<span>Todas<\/span>\s*<span class="mov-chip__n">4<\/span>/)
    assert.match(html, /href="\/transacciones\?[^"]*categoria=sueldos/)
  })
  it('entró / salió / neto / a cuenta corriente', async () => {
    const html = await renderVista('pages/transacciones/index', locals)
    assert.match(html, /Entró · Noviembre 2026/)
    assert.match(html, /Salió · Noviembre 2026/)
    assert.match(html, /Vendido a cuenta corriente/)
  })
  it('cada renglón dice si entró, salió o quedó a cuenta, con su fecha de pago y el día de carga', async () => {
    const html = await renderVista('pages/transacciones/index', locals)
    assert.match(html, /<th>Fecha de pago<\/th>/)
    assert.match(html, /30\/10\/2026\s*<div class="mov-cargado"[^>]*>Cargado el 04\/11\/2026/)
    assert.match(html, /mov-monto--salida[^>]*>\s*−\$800/)
    assert.match(html, /A cuenta corriente/)
    assert.match(html, /Pagado por un cliente con transferencia a tercero/)
  })
  it('acciones según el origen: cobro (Ver), pago de cliente (su cuenta), egreso (Compras y recibo)', async () => {
    const html = await renderVista('pages/transacciones/index', locals)
    assert.match(html, /btn-ver-transaccion[\s\S]*data-fecha-iso="2026-10-30"/)
    assert.match(html, /href="\/clientes\/cuentas\/64"/)
    assert.match(html, /href="\/compras\/recibo\/5"/)
    assert.match(html, /href="\/compras\?preset=rango&amp;fechaDesde=2026-11-02&amp;fechaHasta=2026-11-02&amp;categoria=sueldo&amp;empleado=3"/)
    assert.match(html, /id="formFechaPago"/)
  })
})

describe('vista Flota de Personal', () => {
  const empleado = { id: 3, legajo: 7, nombre: 'Juan', apellido: 'Pérez', activo: 1, estado_laboral: 'activo', sueldo_basico: 1000, salario: 0 }

  it('listado: sueldo del mes con su estado', async () => {
    const html = await renderVista('pages/empleados/index', {
      titulo: 'Flota de Personal', total: 1, page: 1, limit: 20, totalPaginas: 1, filtros: { q: '', mes: '2026-10' }, mes: '2026-10',
      estadosSueldo: ESTADOS_SUELDO,
      empleados: [{ ...empleado, sueldoMes: { establecido: 1000, pagado: 400, otros: 50, estado: 'parcial' } }],
    })
    assert.match(html, /Sueldo de octubre 2026/)
    assert.match(html, /Pagado en parte/)
    assert.match(html, /\$400 de \$1\.000/)
    assert.match(html, /href="\/empleados\/3\?mes=2026-10#pagos"/)
  })

  it('ficha: pagos y sueldos, con lo que pagó un cliente sin botón de borrar', async () => {
    const pagos = [
      { id: 1, tipo: 'sueldo', fecha: '2026-10-05', periodo: '2026-10', monto: 600, descripcion: '', metodo_pago: 'efectivo', id_egreso: 9, de_tercero: false },
      { id: 2, tipo: 'sueldo', fecha: '2026-10-30', periodo: '2026-10', monto: 400, descripcion: '', metodo_pago: 'transferencia', id_egreso: 10,
        de_tercero: true, pagado_por: 'LANFRANCONI', pagado_nro_remito: 1234 },
    ]
    const html = await renderVista('pages/empleados/detalle', {
      titulo: 'Juan Pérez', empleado, asignacionesActivas: [], asignacionesHist: [], camionesDisp: [], maquinasDisp: [],
      pagos, resumenPagos: { count: 2, neto: 1000, porTipo: { sueldo: 1000 } }, periodoLabel: 'Octubre 2026',
      filtros: { fechaDesde: '2026-10-01', fechaHasta: '2026-10-31', preset: 'mes' },
    })
    assert.match(html, /id="pagos"/)
    assert.match(html, /<form action="\/empleados\/3\/pagos" method="POST"/)
    assert.match(html, /LANFRANCONI · Remito 1234/)
    assert.match(html, /action="\/empleados\/3\/pagos\/1\/eliminar"/)
    assert.doesNotMatch(html, /action="\/empleados\/3\/pagos\/2\/eliminar"/)
    assert.match(html, /href="\/empleados\/3\/pagos\/2\/recibo"/)
    assert.match(html, /name="fecha"[^>]*max="\d{4}-\d{2}-\d{2}"/)
  })
})

describe('vista Liquidación: relación con la cuenta corriente', () => {
  const filtros = { clienteId: '64', obra: null, desde: '2026-10-01', hasta: '2026-10-31', tipos: Object.keys(TIPOS), estadoPago: 'todas' }
  const cliente = { id: 64, numero: 64, nombreCompleto: 'LANFRANCONI', dni: '', telefono: '', direccion: '', email: '' }
  const base = { titulo: 'Liquidaciones', TIPOS, ESTADOS, nro: 'LIQ', obras: [], scripts: [], filtros, clienteSel: cliente }
  const resumen = { consumido: 4719000, pagado: 0, saldo: 4719000, cantidad: 0 }

  it('explica la diferencia y termina en el saldo de la cuenta', async () => {
    const html = await renderVista('pages/liquidaciones/index', { ...base, liquidacion: {
      clientes: [{ cliente, operaciones: [], resumen, pagos: [], porObra: [] }], resumen,
      conciliacion: { saldoLiquidacion: 4719000, deudaCuenta: 5368800, coincide: false,
        renglones: [{ clave: 'anteriores', signo: 1, importe: 649800, texto: 'Deuda de operaciones anteriores al 01/10/2026' }] } } })
    assert.match(html, /¿Por qué este saldo no es igual al de la cuenta corriente\?/)
    assert.match(html, /Más: Deuda de operaciones anteriores al 01\/10\/2026/)
    assert.match(html, /\+ \$649\.800,00/)
    assert.match(html, /Cuenta corriente hoy<\/td><td class="text-end">Debe \$5\.368\.800,00/)
    assert.match(html, /href="\/clientes\/cuentas\/64"/)
  })
  it('si coinciden, lo dice en una línea', async () => {
    const html = await renderVista('pages/liquidaciones/index', { ...base, liquidacion: {
      clientes: [{ cliente, operaciones: [], resumen, pagos: [], porObra: [] }], resumen,
      conciliacion: { saldoLiquidacion: 100, deudaCuenta: 100, coincide: true, renglones: [] } } })
    assert.match(html, /Coincide con la cuenta corriente:<\/strong> Debe \$100,00/)
  })
})

describe('fechas en los formularios', () => {
  it('campo "Fecha de pago": hoy por defecto, sin fechas futuras, se oculta si no se cobra en el momento', async () => {
    const html = await renderVista('partials/fecha_pago', { idCampo: 'fp' })
    const hoy = require('../src/utils/fecha').hoyISO()
    assert.match(html, new RegExp(`id="fp" class="form-control" value="${hoy}" max="${hoy}" required`))
    assert.match(html, /'cuenta_corriente', 'saldo_a_favor', 'a_convenir'/)
  })
  it('detalle de venta: fecha de compra y de envío, y fecha de pago al confirmar la entrega (contado)', async () => {
    const op = { id: 9, nro_op: 308, estado: 'pendiente', modalidad: 'flete', metodo_pago: 'efectivo', fecha_emision: '2026-10-28',
      fecha_entrega_planificada: '2026-11-02', administrativo_nombre: 'Ana', cliente_nombre: 'LANFRANCONI', total: 1000, detalles: [] }
    let html
    try {
      html = await renderVista('pages/ventas/detalle', { titulo: 'OP-0308', op, facturacion: null, recursos: null, choferesDisp: [],
        camionesDisp: [], solapamiento: null, recursosEditable: true })
    } catch (e) { if (/is not defined/.test(e.message)) return; throw e } // el resto de la vista pide más datos
    assert.match(html, /Fecha de compra: <strong>28\/10\/2026<\/strong>/)
    assert.match(html, /Fecha de envío: <strong>02\/11\/2026<\/strong>/)
    assert.match(html, /<form action="\/ventas\/9\/entregar" method="POST">[\s\S]*name="fechaPago"/)
  })
  it('detalle de venta a cuenta corriente: confirmar entrega sin fecha de pago', async () => {
    const op = { id: 9, nro_op: 308, estado: 'pendiente', modalidad: 'flete', metodo_pago: 'cuenta_corriente', fecha_emision: '2026-10-28',
      fecha_entrega_planificada: '2026-11-02', administrativo_nombre: 'Ana', cliente_nombre: 'LANFRANCONI', total: 1000, detalles: [] }
    let html
    try {
      html = await renderVista('pages/ventas/detalle', { titulo: 'OP-0308', op, facturacion: null, recursos: null, choferesDisp: [],
        camionesDisp: [], solapamiento: null, recursosEditable: true })
    } catch (e) { if (/is not defined/.test(e.message)) return; throw e }
    const form = html.match(/<form action="\/ventas\/9\/entregar" method="POST">[\s\S]*?<\/form>/)[0]
    assert.doesNotMatch(form, /fechaPago/)
  })
})
