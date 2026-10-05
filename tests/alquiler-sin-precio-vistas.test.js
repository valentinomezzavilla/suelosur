'use strict'
// Vistas de alquileres sin precio: alta, Cobranzas → Asignar precio y parciales. Sin base de datos.
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { renderVista } = require('./helpers/vistas')

const cuenta = (html, re) => (html.match(re) || []).length

describe('alta: sin precio ni método de pago', () => {
  const locals = {
    disponibles: [{ id: 3, numero_contenedor: 19 }, { id: 5, numero_contenedor: 20 }],
    porLiberar: [], choferesDisp: [], camionesDisp: [], zonas: [],
    configPlazos: { cuenta_corriente: 10, estandar: 4 },
  }

  it('el precio y el método de pago solo existen dentro del bloque de la carga histórica, oculto y deshabilitado', async () => {
    const html = await renderVista('pages/alquileres/nuevo', locals)
    const inicio = html.indexOf('id="bloqueCobroHistorico"')
    assert.ok(inicio > 0)
    assert.match(html.slice(inicio - 40, inicio + 80), /style="display:none"/)
    // Un solo campo de precio y un solo selector de método, los dos adentro del bloque
    assert.equal(cuenta(html, /name="precio_alquiler"/g), 1)
    assert.equal(cuenta(html, /name="metodoPago"/g), 1)
    const bloque = html.slice(inicio, html.indexOf('<!-- Facturación -->'))
    assert.match(bloque, /name="precio_alquiler"[^>]*disabled/)
    assert.match(bloque, /name="metodoPago"/)
    assert.doesNotMatch(bloque, /a_convenir/) // el histórico no puede quedar "a convenir"
    assert.doesNotMatch(bloque, /name="paraFacturar"/)
  })

  it('"Operación para facturar" sigue estando, una sola vez y fuera del bloque de precio', async () => {
    const html = await renderVista('pages/alquileres/nuevo', locals)
    assert.equal(cuenta(html, /name="paraFacturar"/g), 1)
    assert.ok(html.indexOf('name="paraFacturar"') > html.indexOf('<!-- Facturación -->'))
  })

  it('avisa que el alquiler se carga sin precio y dónde se asigna', async () => {
    const html = await renderVista('pages/alquileres/nuevo', locals)
    assert.match(html, /id="avisoSinPrecio"/)
    assert.match(html, /sin precio ni método de pago/)
    assert.match(html, /Cobranzas → Asignar precio/)
  })

  it('el bloque de varios contenedores no pide precio ni el modo de cobro', async () => {
    const html = await renderVista('pages/alquileres/nuevo', locals)
    const bloque = html.slice(html.indexOf('id="bloqueVariosContenedores"'), html.indexOf('id="avisoSinPrecio"'))
    assert.doesNotMatch(bloque, /cobro_modo|precio_c|Por contenedor|Por alquiler/)
    assert.match(bloque, /Asignar precio/)
  })

  it('el script del formulario ya no arma campos de precio por contenedor', () => {
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'alquilerService.js'), 'utf8')
    assert.doesNotMatch(js, /precio_c\[/)
    assert.doesNotMatch(js, /multi-cont-precio/)
    assert.match(js, /function pideCobro\(\)/) // solo el histórico ya finalizado pide precio y método
  })
})

describe('parcial de método de pago', () => {
  it('por defecto (ventas, maquinaria) sigue mostrando el selector y el check de facturar', async () => {
    const html = await renderVista('partials/metodo_pago', {})
    assert.match(html, /Metodo de pago/)
    assert.match(html, /name="metodoPago"/)
    assert.match(html, /name="paraFacturar"/)
    assert.doesNotMatch(html, /a_convenir/)
    assert.match(await renderVista('partials/metodo_pago', { conAConvenir: true }), /value="a_convenir"/)
  })

  it('soloFacturar: únicamente el check de facturar', async () => {
    const html = await renderVista('partials/metodo_pago', { soloFacturar: true })
    assert.match(html, /Facturación/)
    assert.match(html, /name="paraFacturar"/)
    assert.doesNotMatch(html, /name="metodoPago"/)
  })

  it('sinFacturar: únicamente el selector de método', async () => {
    const html = await renderVista('partials/metodo_pago', { sinFacturar: true })
    assert.match(html, /name="metodoPago"/)
    assert.doesNotMatch(html, /name="paraFacturar"/)
  })
})

describe('Cobranzas → Asignar precio', () => {
  const fila = (extra) => ({
    id: 101, nro_op: 261, nro_remito: 5, id_cliente: 7, id_grupo: null, estado: 'entregado', obra: null,
    cliente_nombre: 'Cliente Uno', cliente_con_cc: false, saldo_favor_cliente: 0,
    domicilio_entrega: 'San Lorenzo 501', plazo_alquiler: 4, id_contenedor: 1, numero_contenedor: 19,
    fecha_inicio: '2026-09-28', fecha_retiro: null, grupo_cant: null,
    estado_asignar: 'en_curso', dias: 5, precio_sugerido: 120000, ...extra,
  })
  const render = (sinPrecio, pendientes = []) => renderVista('pages/alquileres/cobranzas', { sinPrecio, pendientes })

  it('sin alquileres sin precio, lo dice; las dos secciones están siempre', async () => {
    const html = await render([])
    assert.match(html, /id="asignar-precio"/)
    assert.match(html, /id="a-convenir"/)
    assert.match(html, /No hay alquileres sin precio/)
    assert.match(html, /No hay cobros pendientes/)
  })

  it('una fila muestra cliente, OP, contenedor, domicilio, inicio, estado, días, plazo y precio sugerido', async () => {
    const html = await render([{ todoJunto: false, filas: [fila()] }])
    assert.match(html, /id="op-101"/) // ancla para el link "Asignar precio" del detalle
    assert.match(html, /Cliente Uno/)
    assert.match(html, /OP-0261/)
    assert.match(html, /N° 19/)
    assert.match(html, /San Lorenzo 501/)
    assert.match(html, /28\/09\/2026/)
    assert.match(html, /En curso/)
    assert.match(html, /5 días · plazo 4d/)
    assert.match(html, /\$120\.000,00/)
    // el precio viene prellenado con el sugerido y es editable
    assert.match(html, /name="precio"[^>]*value="120000"/)
    assert.match(html, /action="\/alquileres\/contenedores\/cobranzas\/101\/asignar-precio"/)
  })

  it('el estado se muestra como pendiente / en curso / retirado, y el botón avisa si cobra en el momento', async () => {
    const html = await render([
      { todoJunto: false, filas: [fila({ id: 1, nro_op: 1, estado_asignar: 'retirado', dias: 4 })] },
      { todoJunto: false, filas: [fila({ id: 2, nro_op: 2, estado_asignar: 'en_curso' })] },
      { todoJunto: false, filas: [fila({ id: 3, nro_op: 3, estado: 'pendiente', estado_asignar: 'pendiente', dias: null, id_contenedor: null, numero_contenedor: null })] },
    ])
    assert.match(html, /Retirado/)
    assert.match(html, /Pendiente/)
    assert.equal(cuenta(html, /Asignar y cobrar/g), 1) // solo el ya retirado se cobra al asignar
    assert.match(html, /Sin asignar/) // el pendiente sin contenedor
    assert.match(html, /data-retirado="1"/)
    assert.match(html, /data-retirado="0"/)
  })

  it('cuenta corriente solo se ofrece a un cliente que la tiene; saldo a favor solo si tiene saldo', async () => {
    const sin = await render([{ todoJunto: false, filas: [fila()] }])
    assert.doesNotMatch(sin, /value="cuenta_corriente"/)
    assert.doesNotMatch(sin, /value="saldo_a_favor"/)
    for (const m of ['efectivo', 'transferencia', 'cheque']) assert.match(sin, new RegExp(`value="${m}"`))
    assert.match(sin, /value="a_convenir"[^>]*>A convenir una vez finalizado/)

    const con = await render([{ todoJunto: false, filas: [fila({ cliente_con_cc: true, saldo_favor_cliente: 5000 })] }])
    assert.match(con, /value="cuenta_corriente"/)
    assert.match(con, /value="saldo_a_favor"[^>]*>Usar saldo a favor del cliente \(\$5\.000\)/)
  })

  it('un alquiler agrupado sin precio ofrece asignar todo junto (un precio por contenedor) y cada uno por separado', async () => {
    const f1 = fila({ id: 101, nro_op: 261, id_grupo: 9, grupo_cant: 2, numero_contenedor: 19, cliente_con_cc: true })
    const f2 = fila({ id: 102, nro_op: 262, id_grupo: 9, grupo_cant: 2, numero_contenedor: 20, cliente_con_cc: true, precio_sugerido: 130000 })
    const html = await render([{ todoJunto: true, id_grupo: 9, filas: [f1, f2] }])
    assert.match(html, /Alquiler agrupado · 2 contenedores/)
    assert.match(html, /OP-0261, OP-0262/)
    assert.match(html, /name="cobro_modo" value="alquiler"/)
    assert.match(html, /name="precio\[op101\]"[^>]*value="120000"/)
    assert.match(html, /name="precio\[op102\]"[^>]*value="130000"/)
    assert.match(html, /Asignar todo junto/)
    // ...y además cada contenedor tiene su formulario individual (sin cobro_modo)
    assert.match(html, /cobranzas\/101\/asignar-precio/)
    assert.match(html, /cobranzas\/102\/asignar-precio/)
    assert.equal(cuenta(html, /name="cobro_modo"/g), 1)
    assert.equal(cuenta(html, /Grupo · 2 contenedores/g), 2) // la insignia en cada contenedor
  })

  it('con todo el grupo ya retirado, el botón conjunto cobra al asignar', async () => {
    const f = (id, nro) => fila({ id, nro_op: nro, id_grupo: 9, grupo_cant: 2, estado_asignar: 'retirado', numero_contenedor: nro })
    const html = await render([{ todoJunto: true, id_grupo: 9, filas: [f(101, 261), f(102, 262)] }])
    assert.match(html, /Asignar todo junto y cobrar/)
  })

  it('un contenedor de un grupo que ya se asignó en parte se muestra suelto, sin la asignación conjunta', async () => {
    const html = await render([{ todoJunto: false, filas: [fila({ id_grupo: 9, grupo_cant: 2 })] }])
    assert.doesNotMatch(html, /Asignar todo junto/)
    assert.doesNotMatch(html, /name="cobro_modo"/)
    assert.match(html, /Grupo · 2 contenedores/)
  })

  it('la sección "A convenir" de antes se muestra igual', async () => {
    const html = await render([], [{
      id: 201, nro_op: 300, id_grupo: null, cliente_nombre: 'Viejo', domicilio_entrega: 'Calle 1', numero_contenedor: 7,
      fecha_retiro: '2026-10-01 10:00:00', montoEstimado: 90000, saldo_favor_cliente: 0,
    }])
    assert.match(html, /action="\/alquileres\/contenedores\/cobranzas\/201\/resolver"/)
    assert.match(html, /name="metodo_pago_final"/)
    assert.match(html, /name="precio_final"[^>]*value="90000"/)
  })
})

describe('parciales del alquiler', () => {
  it('panel del grupo: mientras ningún contenedor tiene precio, el cobro está por definir', async () => {
    const grupo = {
      id: 9, cobro_modo: 'contenedor', abiertas: 2,
      ops: [
        { id: 101, nro_op: 261, estado: 'entregado', id_contenedor: 1, numero_contenedor: 19, contenedor_estado: 'en_alquiler', dias_restantes: 3, abierta: true, cobrada: false, precio_alquiler: null },
        { id: 102, nro_op: 262, estado: 'entregado', id_contenedor: 2, numero_contenedor: 20, contenedor_estado: 'en_alquiler', dias_restantes: 3, abierta: true, cobrada: false, precio_alquiler: null },
      ],
    }
    let html = await renderVista('partials/alquiler_grupo', { grupo, opActualId: 101 })
    assert.match(html, /cobro a definir al asignar el precio/)
    assert.equal(cuenta(html, /Sin precio/g), 2)
    assert.doesNotMatch(html, /cobro por contenedor/)
    // con precio, vuelve a decir cómo se cobra
    grupo.ops.forEach(o => { o.precio_alquiler = 100 })
    html = await renderVista('partials/alquiler_grupo', { grupo, opActualId: 101 })
    assert.match(html, /cobro por contenedor/)
    assert.equal(cuenta(html, /Pendiente/g), 2)
  })

  const cierreBase = { precioInicial: 0, precioActual: 90000, precioACobrar: 90000, dias: 3, mesInicio: 'octubre 2026', cambioDePrecio: false }

  it('cierre de un alquiler sin precio: se retira sin monto ni método y dice dónde asignarlo', async () => {
    const html = await renderVista('partials/alquiler_cierre', {
      alquiler: { id: 101, metodo_pago: null }, cierre: { ...cierreBase, sinPrecio: true, precioAsignado: false },
      saldoFavorCliente: 0, grupo: null, cierresGrupo: null,
    })
    assert.match(html, /Registrar retiro<\/p>/)
    assert.match(html, /no tiene precio todavía/)
    assert.match(html, /href="\/alquileres\/contenedores\/cobranzas#op-101"/)
    assert.doesNotMatch(html, /precio_final|metodo_pago_final|pendiente_pago/)
    assert.match(html, /🏠 Registrar retiro<\/button>/)
    assert.match(html, /El alquiler no tiene precio: el cobro se genera cuando se lo asignes en Cobranzas/)
  })

  it('cierre de uno con precio asignado: propone ese precio y no el cálculo por días', async () => {
    const html = await renderVista('partials/alquiler_cierre', {
      alquiler: { id: 101, metodo_pago: 'efectivo' },
      cierre: { ...cierreBase, precioInicial: 777, precioACobrar: 777, sinPrecio: false, precioAsignado: true },
      saldoFavorCliente: 0, grupo: null, cierresGrupo: null,
    })
    assert.match(html, /Precio asignado: <strong>\$777<\/strong>/)
    assert.match(html, /name="precio_final"[^>]*value="777"/)
    assert.doesNotMatch(html, /Precio pactado al inicio/)
    assert.match(html, /Registrar retiro y cobrar/)
  })
})
