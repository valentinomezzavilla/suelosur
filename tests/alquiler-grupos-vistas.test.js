'use strict'
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { renderVista } = require('./helpers/vistas')

describe('vistas de alquileres agrupados', () => {
  it('nuevo: barra de selección múltiple y bloque de varios contenedores con selector de cobro', async () => {
    const html = await renderVista('pages/alquileres/nuevo', {
      disponibles: [{ id: 3, numero_contenedor: 19 }, { id: 5, numero_contenedor: 20 }],
      porLiberar: [], choferesDisp: [], camionesDisp: [], zonas: [],
      configPlazos: { cuenta_corriente: 10, estandar: 4 },
    })
    assert.match(html, /id="barraSeleccion"/)
    assert.match(html, /id="btnContinuarSeleccion"/)
    assert.match(html, /id="bloqueVariosContenedores"/)
    assert.match(html, /id="inputsContenedores"/)
    assert.match(html, /name="cobro_modo" value="contenedor" checked/)
    assert.match(html, /name="cobro_modo" value="alquiler"/)
    assert.match(html, /id="rowCheckFinalizado"/)
  })

  const grupoEjemplo = {
    id: 9, cobro_modo: 'alquiler', abiertas: 1,
    ops: [
      { id: 101, nro_op: 261, estado: 'entregado', id_contenedor: 1, numero_contenedor: 19, contenedor_estado: 'en_alquiler', dias_restantes: 3, abierta: true, cobrada: false },
      { id: 102, nro_op: 262, estado: 'entregado', id_contenedor: 2, numero_contenedor: 20, contenedor_estado: null, dias_restantes: null, abierta: false, cobrada: false },
    ],
  }

  it('panel del grupo: OP, contenedores, estados y aviso de cobro por alquiler', async () => {
    const html = await renderVista('partials/alquiler_grupo', { grupo: grupoEjemplo, opActualId: 101 })
    assert.match(html, /Alquiler agrupado — 2 contenedores · cobro por alquiler/)
    assert.match(html, /OP-0261/)
    assert.match(html, /OP-0262/)
    assert.match(html, /En el domicilio/)
    assert.match(html, /Retirado/)
    assert.match(html, /\(esta\)/)
    assert.match(html, /Faltan retirar 1\./)
  })

  it('editar: el método de pago "a convenir" sigue elegido (no se pierde al guardar)', async () => {
    const alquiler = {
      id: 101, nro_op: 261, estado: 'entregado', metodo_pago: 'a_convenir', observaciones: '', obra: null,
      fecha_entrega_planificada: '2026-09-28', grupo: null,
      detalle: { domicilio_calle: 'San Lorenzo', domicilio_numero: '501', plazo_alquiler: 4, precio_alquiler: 100, zona_entrega: '' },
    }
    const html = await renderVista('pages/alquileres/editar', { alquiler, zonas: [] })
    assert.match(html, /<option value="a_convenir" selected>/)
  })

  it('panel del grupo: botón de anular completo solo si queda alguna OP pendiente', async () => {
    const conPendiente = { ...grupoEjemplo, ops: [{ ...grupoEjemplo.ops[0], estado: 'pendiente' }, grupoEjemplo.ops[1]] }
    assert.match(await renderVista('partials/alquiler_grupo', { grupo: conPendiente, opActualId: 101 }), /anular-grupo/)
    assert.doesNotMatch(await renderVista('partials/alquiler_grupo', { grupo: grupoEjemplo, opActualId: 101 }), /anular-grupo/)
  })

  it('listado: insignia de grupo solo en los alquileres agrupados', async () => {
    const fila = (extra) => ({
      id: 101, nro_op: 261, nro_remito: 5, cliente_nombre: 'Cliente', numero_contenedor: 19,
      domicilio_entrega: 'San Lorenzo 501', obra: null, plazo_alquiler: 4, fecha_entrega_real: '2026-09-28',
      fecha_entrega_planificada: '2026-09-28', fecha_fin_estimada: '2026-10-08', dias_restantes: 6,
      estado: 'entregado', contenedor_estado: 'en_alquiler', id_grupo: null, grupo_cant: 0, ...extra,
    })
    const html = await renderVista('pages/alquileres/index', {
      grupos: { porFinalizar: [], programados: [], actuales: [fila({ id_grupo: 9, grupo_cant: 2 }), fila({ id: 102, nro_op: 262 })] },
      filtros: { q: '' },
    })
    assert.equal((html.match(/Grupo · 2 contenedores/g) || []).length, 1)
    assert.match(html, /href="\/alquileres\/contenedores\/101#grupo"/)
  })

  it('Cobranzas: la fila de un grupo pide el monto de cada contenedor', async () => {
    const html = await renderVista('pages/alquileres/cobranzas', {
      pendientes: [{
        id: 101, nro_op: 261, id_grupo: 9, esGrupo: true, cliente_nombre: 'Cliente', domicilio_entrega: 'San Lorenzo 501',
        numero_contenedor: '19, 20', fecha_retiro: '2026-10-01 10:00:00', montoEstimado: 300, saldo_favor_cliente: 0,
        ops: [
          { id: 101, nro_op: 261, numero_contenedor: 19, montoEstimado: 100 },
          { id: 102, nro_op: 262, numero_contenedor: 20, montoEstimado: 200 },
        ],
      }],
    })
    assert.match(html, /Cobro por alquiler · 2 contenedores/)
    assert.match(html, /name="precio_final\[op101\]"/)
    assert.match(html, /name="precio_final\[op102\]"/)
    assert.match(html, /OP-0261, OP-0262/)
  })

  const cierreEj = { precioInicial: 100, precioActual: 120, dias: 5, mesInicio: 'septiembre 2026', cambioDePrecio: false }
  const grupoAbierto = (otraAbierta) => ({ cobro_modo: 'alquiler', ops: [{ id: 101, abierta: true }, { id: 102, abierta: otraAbierta }] })

  it('cierre de un contenedor suelto: un solo monto, como siempre', async () => {
    const html = await renderVista('partials/alquiler_cierre', { alquiler: { id: 101, metodo_pago: 'efectivo' }, cierre: cierreEj, saldoFavorCliente: 0, grupo: null, cierresGrupo: null })
    assert.match(html, /name="precio_final"/)
    assert.match(html, /Registrar retiro y cobrar/)
  })

  it('cierre en grupo por alquiler con otro contenedor afuera: retiro sin cobro', async () => {
    const html = await renderVista('partials/alquiler_cierre', { alquiler: { id: 101, metodo_pago: 'a_convenir' }, cierre: cierreEj, saldoFavorCliente: 0, grupo: grupoAbierto(true), cierresGrupo: null })
    assert.doesNotMatch(html, /name="precio_final/)
    assert.doesNotMatch(html, /metodo_pago_final/) // el método se pide recién en el último
    assert.match(html, /se cobra todo junto al retirar el último/)
    assert.match(html, /\(falta 1\)/)
  })

  it('cierre del último contenedor del grupo: un monto por contenedor', async () => {
    const html = await renderVista('partials/alquiler_cierre', {
      alquiler: { id: 101, metodo_pago: 'efectivo' }, cierre: cierreEj, saldoFavorCliente: 0, grupo: grupoAbierto(false),
      cierresGrupo: [{ id: 101, numero_contenedor: 19, precioActual: 120 }, { id: 102, numero_contenedor: 20, precioActual: 130 }],
    })
    assert.match(html, /name="precio_final\[op101\]"/)
    assert.match(html, /name="precio_final\[op102\]"/)
    assert.match(html, /Se cobra todo el alquiler: 2 contenedores/)
  })
})
