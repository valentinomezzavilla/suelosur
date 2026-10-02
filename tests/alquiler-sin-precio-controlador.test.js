'use strict'
// Alquileres sin precio, de punta a punta por los controladores: alta, retiro de la oficina y
// del chofer (hoja de ruta), Cobranzas → Asignar precio, detalle y edición. Dentro de la
// transacción de prueba (ROLLBACK al final).
const prueba = require('./helpers/db')
const datos = require('./helpers/datos')
const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const AlquileresModel = require('../src/models/alquileres.model')
const HojaRutaController = require('../src/controllers/hojaRuta.controller')
const { llamar } = require('./helpers/controlador')
const { renderVista } = require('./helpers/vistas')
const { hoyISO } = require('../src/utils/fecha')
const { sumarDiasHabiles } = require('../src/utils/diasHabiles')

// Llama una acción de la hoja de ruta del chofer con req/res mínimos.
function llamarHojaRuta(accion, { body = {}, params = {}, user }) {
  return new Promise((resolve, reject) => {
    const flashes = []
    const req = { body, params, session: { user }, flash: (tipo, msg) => flashes.push({ tipo, msg }) }
    const res = { redirect: (url) => resolve({ url, flashes }), render: (vista, data) => resolve({ vista, data, flashes }), json: (d) => resolve({ json: d, flashes }), status() { return this } }
    Promise.resolve(HojaRutaController[accion](req, res)).catch(reject)
  })
}

const correrDias = (iso, n) => {
  const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + n)
  const p = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
const haceDias = (n) => correrDias(hoyISO(), -n)

describe('alquileres sin precio: controladores', () => {
  let admin
  const futuro = sumarDiasHabiles(hoyISO(), 3) // inicio a futuro: alta normal, no "ya en curso"

  before(async () => {
    await prueba.abrir()
    admin = { id: await datos.idAdministrativo(), rol: 'dueno' }
    AlquileresModel.ubicar = async () => null // sin llamadas a Nominatim en las pruebas
  })
  after(prueba.cerrar)

  const opsDe = async (id_cliente) => (await prueba.q(`
    SELECT op.id, op.nro_op, op.estado, op.metodo_pago, op.monto_facturar, oc.metodo_pago AS metodo_detalle,
           oc.plazo_alquiler, oc.precio_alquiler, oc.id_contenedor
    FROM op_encabezado op JOIN op_detalle_contenedor oc ON oc.id_orden_pedido = op.id
    WHERE op.id_cliente = ? ORDER BY op.id`, [id_cliente])).rows
  const txDe = async (id) => (await prueba.q(`SELECT monto, metodo_pago, fecha FROM transacciones WHERE id_op_encabezado = ? ORDER BY id`, [id])).rows
  const cuerpo = (extra) => ({ calle: 'San Lorenzo', numero: '501', fechaInicio: futuro, fechaFin: sumarDiasHabiles(futuro, 4), ...extra })
  const AVISO = 'Falta asignarle el precio: Cobranzas → Asignar precio.'

  async function enCurso({ cuentaCorriente = false, saldo = 0, dias = 3, plazo = 4 } = {}) {
    const id_cliente = await datos.crearCliente({ cuentaCorriente, saldo })
    const [cont] = await datos.crearContenedores(1)
    const r = await AlquileresModel.crearEnCurso({
      ...datos.datosComunes({ id_cliente, id_administrativo: admin.id, metodo_pago: null, fecha_inicio: haceDias(dias) }),
      id_contenedor: cont, plazo_alquiler: plazo,
    })
    return { id: r.id, id_cliente, cont }
  }

  describe('alta', () => {
    it('un alquiler normal se crea sin precio ni método, y el aviso dice dónde asignarlo', async () => {
      const id_cliente = await datos.crearCliente()
      const [cont] = await datos.crearContenedores(1)
      const r = await llamar('crear', { user: admin, body: cuerpo({ clienteId: String(id_cliente), id_contenedor: String(cont) }) })
      assert.equal(r.url, '/alquileres/contenedores')
      assert.equal(r.flashes[0].tipo, 'success')
      assert.match(r.flashes[0].msg, /^Alquiler OP-\d{4} creado\. /)
      assert.ok(r.flashes[0].msg.endsWith(AVISO))
      const [op] = await opsDe(id_cliente)
      assert.deepEqual([op.precio_alquiler, op.metodo_pago, op.metodo_detalle, op.estado], [null, null, null, 'pendiente'])
    })

    it('el precio y el método de un formulario viejo se ignoran', async () => {
      const id_cliente = await datos.crearCliente({ cuentaCorriente: true })
      const [cont] = await datos.crearContenedores(1)
      await llamar('crear', { user: admin, body: cuerpo({
        clienteId: String(id_cliente), id_contenedor: String(cont), precio_alquiler: '100', metodoPago: 'cuenta_corriente',
      }) })
      const [op] = await opsDe(id_cliente)
      assert.deepEqual([op.precio_alquiler, op.metodo_pago, op.metodo_detalle], [null, null, null])
    })

    it('"Operación para facturar" sin precio no guarda $0 como monto a facturar', async () => {
      const id_cliente = await datos.crearCliente()
      const [cont] = await datos.crearContenedores(1)
      await llamar('crear', { user: admin, body: cuerpo({ clienteId: String(id_cliente), id_contenedor: String(cont), paraFacturar: '1' }) })
      const [op] = await opsDe(id_cliente)
      assert.equal((await prueba.q(`SELECT para_facturar FROM op_encabezado WHERE id = ?`, [op.id])).rows[0].para_facturar, 1)
      assert.equal(op.monto_facturar, null)
    })

    it('el plazo por defecto sigue siendo 10 días con cuenta corriente y 4 sin ella, sin método de pago', async () => {
      const conCC = await datos.crearCliente({ cuentaCorriente: true })
      const sinCC = await datos.crearCliente()
      const [c1, c2] = await datos.crearContenedores(2)
      await llamar('crear', { user: admin, body: cuerpo({ clienteId: String(conCC), id_contenedor: String(c1) }) })
      await llamar('crear', { user: admin, body: cuerpo({ clienteId: String(sinCC), id_contenedor: String(c2) }) })
      assert.equal((await opsDe(conCC))[0].plazo_alquiler, 10)
      assert.equal((await opsDe(sinCC))[0].plazo_alquiler, 4)
    })

    it('"ya en curso" (inicio anterior a hoy) se carga entregado y sin precio', async () => {
      const id_cliente = await datos.crearCliente()
      const [cont] = await datos.crearContenedores(1)
      const inicio = haceDias(5)
      const r = await llamar('crear', { user: admin, body: cuerpo({
        clienteId: String(id_cliente), id_contenedor: String(cont), fechaInicio: inicio, fechaFin: sumarDiasHabiles(inicio, 4),
      }) })
      assert.match(r.flashes[0].msg, new RegExp(`^Alquiler OP-\\d{4} cargado como en curso desde el ${inicio}\\. `))
      assert.ok(r.flashes[0].msg.endsWith(AVISO))
      const [op] = await opsDe(id_cliente)
      assert.deepEqual([op.estado, op.precio_alquiler, op.metodo_pago], ['entregado', null, null])
    })

    it('el próximo alquiler encadenado ("próximos a finalizar") también se carga sin precio', async () => {
      const actual = await enCurso()
      const id_cliente = await datos.crearCliente()
      const r = await llamar('crear', { user: admin, body: cuerpo({
        clienteId: String(id_cliente), id_contenedor: String(actual.cont), alquiler_actual_id: String(actual.id),
      }) })
      assert.match(r.flashes[0].msg, /^Alquiler OP-\d{4} programado\. /)
      const [op] = await opsDe(id_cliente)
      assert.deepEqual([op.estado, op.precio_alquiler, op.metodo_pago], ['pendiente', null, null])
    })

    it('carga histórica "ya finalizó": sigue pidiendo precio y método, y registra el ingreso con la fecha pasada', async () => {
      const id_cliente = await datos.crearCliente()
      const base = { clienteId: String(id_cliente), finalizado: '1', estado_historico: 'finalizado', fechaInicio: '2026-08-03', fechaFin: '2026-08-07' }

      let r = await llamar('crear', { user: admin, body: cuerpo({ ...base }) })
      assert.deepEqual(r.flashes, [{ tipo: 'error', msg: 'Ingresá el precio del alquiler.' }])
      r = await llamar('crear', { user: admin, body: cuerpo({ ...base, precio_alquiler: '2000', metodoPago: 'a_convenir' }) })
      assert.deepEqual(r.flashes, [{ tipo: 'error', msg: 'Elegí un método de pago.' }])
      assert.equal((await opsDe(id_cliente)).length, 0)

      r = await llamar('crear', { user: admin, body: cuerpo({ ...base, precio_alquiler: '2000', metodoPago: 'transferencia' }) })
      assert.match(r.flashes[0].msg, /^Alquiler finalizado OP-\d{4} cargado \(histórico\)\.$/)
      const [op] = await opsDe(id_cliente)
      assert.deepEqual([op.precio_alquiler, op.metodo_pago, op.estado], [2000, 'transferencia', 'entregado'])
      const tx = await txDe(op.id)
      assert.deepEqual([tx.length, tx[0].monto, tx[0].metodo_pago], [1, 2000, 'transferencia'])
      assert.equal(String(tx[0].fecha).slice(0, 10), '2026-08-07') // la fecha del alquiler, no la de hoy
    })

    it('carga histórica "ya finalizó" a cuenta corriente: solo si el cliente la tiene', async () => {
      const sinCC = await datos.crearCliente()
      const r = await llamar('crear', { user: admin, body: cuerpo({
        clienteId: String(sinCC), finalizado: '1', estado_historico: 'finalizado', fechaInicio: '2026-08-03', fechaFin: '2026-08-07',
        precio_alquiler: '2000', metodoPago: 'cuenta_corriente',
      }) })
      assert.match(r.flashes[0].msg, /no tiene la cuenta corriente habilitada/)
      assert.equal((await opsDe(sinCC)).length, 0)
    })

    it('carga histórica "sigue en curso": sin precio ni método, como los demás', async () => {
      const id_cliente = await datos.crearCliente()
      const [cont] = await datos.crearContenedores(1)
      const r = await llamar('crear', { user: admin, body: cuerpo({
        clienteId: String(id_cliente), finalizado: '1', estado_historico: 'en_curso', id_contenedor: String(cont),
        fechaInicio: haceDias(10), precio_alquiler: '999', metodoPago: 'efectivo',
      }) })
      assert.match(r.flashes[0].msg, /cargado como en curso/)
      const [op] = await opsDe(id_cliente)
      assert.deepEqual([op.estado, op.precio_alquiler, op.metodo_pago], ['entregado', null, null])
      assert.deepEqual(await txDe(op.id), [])
    })
  })

  describe('retiro', () => {
    it('la oficina retira un alquiler sin precio: no se bloquea, no cobra y avisa dónde asignarlo', async () => {
      const a = await enCurso({ cuentaCorriente: true })
      const r = await llamar('devolverAPlanta', { user: admin, params: { id: String(a.id) }, body: {} })
      assert.deepEqual(r.flashes, [{ tipo: 'success', msg: 'Contenedor retirado. El alquiler no tiene precio todavía: asignalo en Cobranzas → Asignar precio para que se genere el cobro.' }])
      assert.deepEqual(await txDe(a.id), [])
      assert.equal((await prueba.q(`SELECT COUNT(*)::int AS n FROM movimientos_cuenta WHERE cliente_id = ?`, [a.id_cliente])).rows[0].n, 0)
    })

    it('la oficina retira uno con precio asignado: cobra ese precio', async () => {
      const a = await enCurso({ dias: 6 })
      await AlquileresModel.asignarPrecio(a.id, { precio: '777', metodo_pago: 'efectivo' })
      const r = await llamar('devolverAPlanta', { user: admin, params: { id: String(a.id) }, body: { precio_final: '777' } })
      assert.deepEqual(r.flashes, [{ tipo: 'success', msg: 'Contenedor retirado — alquiler cerrado por $777.' }])
      assert.deepEqual((await txDe(a.id)).map(t => t.monto), [777])
    })

    // Chofer: sale a retirar desde la hoja de ruta (el retiro tiene que estar iniciado).
    async function conChoferRetirando(a) {
      const { id_usuario, id_empleado } = await datos.crearChofer()
      await prueba.q(`UPDATE op_encabezado SET id_chofer = ? WHERE id = ?`, [id_empleado, a.id])
      await AlquileresModel.registrarRetiro(a.id)
      await AlquileresModel.iniciarRetiro(a.id)
      return { id: String(a.id), user: { id: id_usuario, rol: 'chofer' } }
    }
    const estadoContenedor = async (cont) => (await prueba.q(`SELECT estado_paso FROM movimiento_contenedor WHERE id_contenedor = ? ORDER BY id DESC LIMIT 1`, [cont])).rows[0].estado_paso

    it('el chofer retira un alquiler sin precio desde la hoja de ruta: no se bloquea ni genera cobro', async () => {
      const a = await enCurso({ cuentaCorriente: true })
      const { id, user } = await conChoferRetirando(a)
      const r = await llamarHojaRuta('finalizar', { user, params: { id }, body: {} })
      assert.equal(r.url, '/hoja-de-ruta')
      assert.deepEqual(r.flashes, [{ tipo: 'success', msg: 'Contenedor retirado y devuelto a planta. ¡Tarea completada!' }])
      assert.equal(await estadoContenedor(a.cont), 'disponible')
      assert.deepEqual(await txDe(a.id), [])
      assert.equal((await AlquileresModel.sinPrecio()).flatMap(b => b.filas).find(f => f.id === a.id).estado_asignar, 'retirado')
    })

    it('el chofer retira uno con precio asignado: se cobra el precio asignado, sin que él cargue nada', async () => {
      const a = await enCurso({ dias: 6 })
      await AlquileresModel.asignarPrecio(a.id, { precio: '777', metodo_pago: 'transferencia' })
      const { id, user } = await conChoferRetirando(a)
      await llamarHojaRuta('finalizar', { user, params: { id }, body: {} })
      assert.deepEqual((await txDe(a.id)).map(t => [t.monto, t.metodo_pago]), [[777, 'transferencia']])
    })

    it('el chofer lleva el contenedor al próximo alquiler (encadenado) y el anterior, sin precio, no cobra', async () => {
      const a = await enCurso()
      const otro = await datos.crearCliente()
      const b = await AlquileresModel.crearProgramado({
        ...datos.datosComunes({ id_cliente: otro, id_administrativo: admin.id, metodo_pago: null }),
        id_contenedor: a.cont, alquiler_actual_id: a.id, plazo_alquiler: 4,
      })
      const { id, user } = await conChoferRetirando(a)
      const r = await llamarHojaRuta('finalizar', { user, params: { id }, body: { destino_retiro: 'proximo' } })
      assert.equal(r.url, `/hoja-de-ruta/${b.id}/viaje-en-curso`)
      assert.deepEqual(await txDe(a.id), [])
    })
  })

  describe('ampliar el plazo', () => {
    it('un alquiler sin precio se amplía como siempre', async () => {
      const a = await enCurso({ plazo: 4 })
      const r = await llamar('ampliar', { user: admin, params: { id: String(a.id) } })
      assert.deepEqual(r.flashes, [{ tipo: 'success', msg: 'Alquiler ampliado 4 días.' }])
      assert.equal((await prueba.q(`SELECT plazo_alquiler FROM op_detalle_contenedor WHERE id_orden_pedido = ?`, [a.id])).rows[0].plazo_alquiler, 8)
    })

    it('con el precio ya asignado y sin cobrar, avisa que el precio no se recalcula', async () => {
      const a = await enCurso({ plazo: 4 })
      await AlquileresModel.asignarPrecio(a.id, { precio: '120000', metodo_pago: 'efectivo' })
      const r = await llamar('ampliar', { user: admin, params: { id: String(a.id) } })
      assert.equal(r.flashes[0].tipo, 'success')
      assert.equal(r.flashes[0].msg, 'Alquiler ampliado 4 días. Ya tiene el precio asignado ($120.000): si corresponde, actualizalo en Editar antes del retiro.')
    })
  })

  describe('Cobranzas → Asignar precio', () => {
    it('la pantalla trae los alquileres sin precio y, aparte, los "a convenir" de antes', async () => {
      const a = await enCurso()
      const id_cliente = await datos.crearCliente()
      const [cont] = await datos.crearContenedores(1)
      const viejo = await AlquileresModel.crearEnCurso({
        ...datos.datosComunes({ id_cliente, id_administrativo: admin.id, metodo_pago: 'a_convenir', fecha_inicio: haceDias(5) }),
        id_contenedor: cont, plazo_alquiler: 4, precio_alquiler: 100,
      })
      await AlquileresModel.devolverAPlanta(viejo.id)
      const r = await llamar('cobranzas', { user: admin })
      assert.equal(r.vista, 'pages/alquileres/cobranzas')
      assert.ok(r.data.sinPrecio.flatMap(b => b.filas).some(f => f.id === a.id))
      assert.equal(r.data.sinPrecio.flatMap(b => b.filas).some(f => f.id === viejo.id), false)
      const pend = r.data.pendientes.find(p => p.id === viejo.id)
      assert.ok(pend && pend.montoEstimado > 0)

      const html = await renderVista(r.vista, r.data)
      assert.match(html, /Asignar precio/)
      assert.match(html, new RegExp(`action="/alquileres/contenedores/cobranzas/${a.id}/asignar-precio"`))
      assert.match(html, new RegExp(`action="/alquileres/contenedores/cobranzas/${viejo.id}/resolver"`)) // "a convenir" sigue igual
    })

    it('asignar un alquiler retirado: cobra en el momento y deja registro de quién lo hizo', async () => {
      const a = await enCurso({ cuentaCorriente: true })
      await AlquileresModel.devolverAPlanta(a.id)
      const r = await llamar('asignarPrecio', { user: admin, params: { id: String(a.id) }, body: { precio: '155000', metodo_pago: 'cuenta_corriente' } })
      assert.equal(r.url, '/alquileres/contenedores/cobranzas')
      assert.deepEqual(r.flashes, [{ tipo: 'success', msg: 'Precio asignado: $155.000 (cuenta corriente). Cobro registrado.' }])
      assert.deepEqual((await txDe(a.id)).map(t => [t.monto, t.metodo_pago]), [[155000, 'cuenta_corriente']])
      const aud = (await prueba.q(`SELECT accion, id_usuario, detalle FROM auditoria WHERE entidad_tipo = 'alquiler' AND entidad_id = ?`, [a.id])).rows
      assert.equal(aud.length, 1)
      assert.deepEqual([aud[0].accion, Number(aud[0].id_usuario)], ['asignar_precio', admin.id])
      assert.deepEqual(JSON.parse(aud[0].detalle), { precio: 155000, metodo_pago: 'cuenta_corriente', cobrado: true })
    })

    it('asignar uno que sigue en curso: avisa que se cobra al retirar', async () => {
      const a = await enCurso()
      const r = await llamar('asignarPrecio', { user: admin, params: { id: String(a.id) }, body: { precio: '90000', metodo_pago: 'efectivo' } })
      assert.deepEqual(r.flashes, [{ tipo: 'success', msg: 'Precio asignado: $90.000 (efectivo). El cobro se genera al retirar el contenedor.' }])
      assert.deepEqual(await txDe(a.id), [])
    })

    it('cuenta corriente a un cliente sin cuenta: vuelve a Cobranzas con un mensaje claro y sin cambios', async () => {
      const a = await enCurso({ cuentaCorriente: false })
      const r = await llamar('asignarPrecio', { user: admin, params: { id: String(a.id) }, body: { precio: '1000', metodo_pago: 'cuenta_corriente' } })
      assert.equal(r.url, '/alquileres/contenedores/cobranzas')
      assert.equal(r.flashes[0].tipo, 'error')
      assert.match(r.flashes[0].msg, /no tiene la cuenta corriente habilitada/)
      assert.equal((await prueba.q(`SELECT precio_alquiler FROM op_detalle_contenedor WHERE id_orden_pedido = ?`, [a.id])).rows[0].precio_alquiler, null)
    })

    it('sin precio o sin método: error y no se asigna', async () => {
      const a = await enCurso()
      let r = await llamar('asignarPrecio', { user: admin, params: { id: String(a.id) }, body: { precio: '', metodo_pago: 'efectivo' } })
      assert.deepEqual(r.flashes, [{ tipo: 'error', msg: 'Ingresá el precio del alquiler.' }])
      r = await llamar('asignarPrecio', { user: admin, params: { id: String(a.id) }, body: { precio: '100', metodo_pago: '' } })
      assert.deepEqual(r.flashes, [{ tipo: 'error', msg: 'Elegí un método de pago.' }])
    })

    it('alquiler agrupado todo junto: un precio por contenedor, un método y un cargo por el total', async () => {
      const id_cliente = await datos.crearCliente({ cuentaCorriente: true })
      const conts = await datos.crearContenedores(2)
      const g = await AlquileresModel.crearGrupo({
        ...datos.datosComunes({ id_cliente, id_administrativo: admin.id, metodo_pago: null, fecha_inicio: haceDias(3) }),
        en_curso: true, contenedores: conts.map(id_contenedor => ({ id_contenedor, plazo_alquiler: 4 })),
      })
      const [op1, op2] = g.ops.map(o => o.id)
      for (const id of [op1, op2]) await AlquileresModel.devolverAPlanta(id)
      const r = await llamar('asignarPrecio', { user: admin, params: { id: String(op1) }, body: {
        cobro_modo: 'alquiler', metodo_pago: 'cuenta_corriente', precio: { ['op' + op1]: '100', ['op' + op2]: '250' },
      } })
      assert.deepEqual(r.flashes, [{ tipo: 'success', msg: 'Precio asignado al alquiler agrupado: $350 en total (cuenta corriente). Se cobró todo junto.' }])
      assert.deepEqual([(await txDe(op1))[0].monto, (await txDe(op2))[0].monto], [100, 250])
      const movs = (await prueba.q(`SELECT tipo, monto FROM movimientos_cuenta WHERE cliente_id = ?`, [id_cliente])).rows
      assert.deepEqual(movs.map(m => [m.tipo, m.monto]), [['deuda', -350]])
    })

    it('alquiler agrupado todo junto con un contenedor afuera: avisa que se cobra al retirar el último', async () => {
      const id_cliente = await datos.crearCliente()
      const conts = await datos.crearContenedores(2)
      const g = await AlquileresModel.crearGrupo({
        ...datos.datosComunes({ id_cliente, id_administrativo: admin.id, metodo_pago: null, fecha_inicio: haceDias(3) }),
        en_curso: true, contenedores: conts.map(id_contenedor => ({ id_contenedor, plazo_alquiler: 4 })),
      })
      const [op1, op2] = g.ops.map(o => o.id)
      const r = await llamar('asignarPrecio', { user: admin, params: { id: String(op1) }, body: {
        cobro_modo: 'alquiler', metodo_pago: 'efectivo', precio: { ['op' + op1]: '100', ['op' + op2]: '250' },
      } })
      assert.deepEqual(r.flashes, [{ tipo: 'success', msg: 'Precio asignado al alquiler agrupado: $350 en total (efectivo). Se cobra todo junto al retirar el último contenedor.' }])
    })
  })

  describe('detalle y edición', () => {
    it('el detalle de un alquiler sin precio dice "Sin precio" y ofrece asignarlo; el cierre no pide monto', async () => {
      const a = await enCurso()
      const r = await llamar('detalle', { user: admin, params: { id: String(a.id) } })
      assert.equal(r.vista, 'pages/alquileres/detalle')
      assert.equal(r.data.cierre.sinPrecio, true)
      const html = await renderVista(r.vista, r.data)
      assert.match(html, /Sin precio/)
      assert.match(html, new RegExp(`href="/alquileres/contenedores/cobranzas#op-${a.id}"`))
      assert.match(html, /A definir al asignar el precio/)
      assert.doesNotMatch(html, /name="precio_final"/)
      assert.match(html, /Registrar retiro<\/button>/)
    })

    it('el detalle con el precio ya asignado lo muestra y prellena el cierre con ese precio', async () => {
      const a = await enCurso({ dias: 6 })
      await AlquileresModel.asignarPrecio(a.id, { precio: '777', metodo_pago: 'efectivo' })
      const r = await llamar('detalle', { user: admin, params: { id: String(a.id) } })
      const html = await renderVista(r.vista, r.data)
      assert.doesNotMatch(html, /Sin precio/)
      assert.match(html, /\$777\.00/)
      assert.match(html, /Precio asignado: <strong>\$777<\/strong>/)
      assert.match(html, /name="precio_final"[^>]*value="777"/)
    })

    it('editar un alquiler sin precio no muestra precio ni método; guardar la edición no los toca', async () => {
      const a = await enCurso()
      const e = await llamar('editar', { user: admin, params: { id: String(a.id) } })
      const html = await renderVista(e.vista, e.data)
      assert.doesNotMatch(html, /name="precio_alquiler"/)
      assert.doesNotMatch(html, /name="metodo_pago"/)
      assert.match(html, /Asignar precio<\/a> en Cobranzas/)

      const g = await llamar('actualizar', { user: admin, params: { id: String(a.id) }, body: {
        calle: 'Av. Colón', numero: '100', zona_entrega: '', fechaInicio: haceDias(3), fechaFin: sumarDiasHabiles(haceDias(3), 4), obra: '', observaciones: 'editado',
      } })
      assert.deepEqual(g.flashes, [{ tipo: 'success', msg: 'Alquiler actualizado.' }])
      const d = (await prueba.q(`SELECT precio_alquiler, metodo_pago, domicilio_calle FROM op_detalle_contenedor WHERE id_orden_pedido = ?`, [a.id])).rows[0]
      assert.deepEqual([d.precio_alquiler, d.metodo_pago, d.domicilio_calle], [null, null, 'Av. Colón'])
    })

    it('el historial de alquileres del contenedor dice "Sin precio" en vez de un guion', async () => {
      const a = await enCurso()
      const ContenedoresModel = require('../src/models/contenedores.model')
      const contenedor = await ContenedoresModel.obtener(a.cont)
      const html = await renderVista('pages/contenedores/detalle', {
        contenedor, choferes: await ContenedoresModel.choferes(), camiones: await ContenedoresModel.camiones(),
      })
      assert.match(html, /<small class="fw-semibold">Sin precio<\/small>/)
    })

    it('el listado marca los alquileres sin precio y avisa cuántos hay en el botón de Cobranzas', async () => {
      const a = await enCurso()
      const r = await llamar('index', { user: admin })
      assert.equal(r.vista, 'pages/alquileres/index')
      assert.ok(r.data.sinPrecio >= 1)
      const html = await renderVista(r.vista, r.data)
      assert.match(html, new RegExp(`href="/alquileres/contenedores/cobranzas#op-${a.id}"[^>]*>Sin precio</a>`))
      assert.match(html, /Cobranzas <span class="badge[^>]*>\d+<\/span>/)
    })
  })
})
