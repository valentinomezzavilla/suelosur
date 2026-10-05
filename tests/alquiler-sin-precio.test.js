'use strict'
// Alquileres de contenedor SIN precio: el alta no pide precio ni método de pago, el alquiler
// queda en Cobranzas → Asignar precio y se cobra cuando se le asigna. Corre dentro de la
// transacción de prueba (ROLLBACK al final: nada queda guardado).
const prueba = require('./helpers/db')
const datos = require('./helpers/datos')
const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const AlquileresModel = require('../src/models/alquileres.model')
const ConfigContenedoresModel = require('../src/models/config_contenedores.model')
const ClientesModel = require('../src/models/clientes.model')
const FacturacionModel = require('../src/models/facturacion.model')
const ReportesModel = require('../src/models/reportes.model')
const RemitosModel = require('../src/models/remitos.model')
const TransaccionesModel = require('../src/models/transacciones.model')
const { generarRemitoPDFBuffer } = require('../src/utils/pdfRemito')
const { hoyISO } = require('../src/utils/fecha')

// 'YYYY-MM-DD' corrido n días (hora local)
const correrDias = (iso, n) => {
  const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + n)
  const p = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
const haceDias = (n) => correrDias(hoyISO(), -n)

describe('alquileres sin precio', () => {
  let admin

  before(async () => {
    await prueba.abrir()
    admin = await datos.idAdministrativo()
  })
  after(prueba.cerrar)

  // ── Armado de alquileres de prueba (todos sin precio ni método, como los del alta nueva) ──
  const comunes = (id_cliente, dias = 3) => datos.datosComunes({
    id_cliente, id_administrativo: admin, metodo_pago: null, fecha_inicio: haceDias(dias),
  })
  async function enCurso({ cuentaCorriente = false, saldo = 0, dias = 3, plazo = 4, id_cliente } = {}) {
    id_cliente = id_cliente || await datos.crearCliente({ cuentaCorriente, saldo })
    const [cont] = await datos.crearContenedores(1)
    const r = await AlquileresModel.crearEnCurso({ ...comunes(id_cliente, dias), id_contenedor: cont, plazo_alquiler: plazo })
    return { id: r.id, nro_op: r.nro_op, id_cliente, cont, inicio: haceDias(dias) }
  }
  async function pendiente({ cuentaCorriente = false, plazo = 4 } = {}) {
    const id_cliente = await datos.crearCliente({ cuentaCorriente })
    const [cont] = await datos.crearContenedores(1)
    const r = await AlquileresModel.crear({ ...comunes(id_cliente, -3), id_contenedor: cont, plazo_alquiler: plazo })
    return { id: r.id, nro_op: r.nro_op, id_cliente, cont }
  }
  async function retirado(opts = {}) {
    const a = await enCurso(opts)
    await AlquileresModel.devolverAPlanta(a.id)
    return a
  }
  async function grupoSinPrecio({ cuentaCorriente = false, n = 2, dias = 3 } = {}) {
    const id_cliente = await datos.crearCliente({ cuentaCorriente })
    const conts = await datos.crearContenedores(n)
    const g = await AlquileresModel.crearGrupo({
      ...comunes(id_cliente, dias), en_curso: true,
      contenedores: conts.map(id_contenedor => ({ id_contenedor, plazo_alquiler: 4 })),
    })
    return { id_cliente, id_grupo: g.id_grupo, ops: g.ops.map(o => o.id), conts }
  }

  // ── Consultas de apoyo ──
  const detalle = async (id) => (await prueba.q(`
    SELECT oc.precio_alquiler, oc.metodo_pago AS metodo_detalle, oc.precio_asignado_en, op.metodo_pago AS metodo_op, op.estado
    FROM op_encabezado op JOIN op_detalle_contenedor oc ON oc.id_orden_pedido = op.id WHERE op.id = ?`, [id])).rows[0]
  const txDe = async (id) => (await prueba.q(`SELECT monto, metodo_pago, descripcion FROM transacciones WHERE id_op_encabezado = ? ORDER BY id`, [id])).rows
  const movsDe = async (id_cliente) => (await prueba.q(`SELECT tipo, monto, id_op_encabezado FROM movimientos_cuenta WHERE cliente_id = ? ORDER BY id`, [id_cliente])).rows
  const saldoDe = async (id_cliente) => (await prueba.q(`SELECT saldo FROM clientes WHERE id = ?`, [id_cliente])).rows[0].saldo
  const filasSinPrecio = async () => (await AlquileresModel.sinPrecio()).flatMap(b => b.filas)
  const estaEnAsignar = async (id) => (await filasSinPrecio()).some(f => f.id === id)

  describe('alta y retiro', () => {
    it('un alquiler normal se guarda sin precio (NULL, no $0) y sin método de pago', async () => {
      const a = await pendiente()
      const d = await detalle(a.id)
      assert.equal(d.precio_alquiler, null)
      assert.equal(d.metodo_op, null)
      assert.equal(d.metodo_detalle, null)
      assert.equal(d.precio_asignado_en, null)
    })

    it('"sin precio" se distingue de "precio cero": un cero explícito se guarda como 0', async () => {
      const id_cliente = await datos.crearCliente()
      const [cont] = await datos.crearContenedores(1)
      const r = await AlquileresModel.crear({ ...comunes(id_cliente, -3), id_contenedor: cont, plazo_alquiler: 4, precio_alquiler: 0 })
      assert.equal((await detalle(r.id)).precio_alquiler, 0)
      assert.equal(await estaEnAsignar(r.id), false)
    })

    it('"ya en curso", programado (encadenado) y de varios contenedores también nacen sin precio', async () => {
      const a = await enCurso()
      assert.equal((await detalle(a.id)).precio_alquiler, null)
      assert.equal((await detalle(a.id)).estado, 'entregado')

      const otro = await datos.crearCliente()
      const p = await AlquileresModel.crearProgramado({
        ...comunes(otro, -10), id_contenedor: a.cont, alquiler_actual_id: a.id, plazo_alquiler: 4,
      })
      assert.equal((await detalle(p.id)).precio_alquiler, null)
      assert.equal((await detalle(p.id)).metodo_op, null)

      const g = await grupoSinPrecio()
      for (const id of g.ops) assert.equal((await detalle(id)).precio_alquiler, null)
    })

    it('retirar sin precio no se bloquea y no genera cobro: ni transacción ni cargo, ni siquiera de $0', async () => {
      const a = await enCurso({ cuentaCorriente: true })
      await AlquileresModel.devolverAPlanta(a.id) // el retiro no se bloquea
      assert.equal(await AlquileresModel.cobrarAlCerrar(a.id), null)
      assert.equal(await AlquileresModel.cobrarAlCerrar(a.id, '5000', 'efectivo'), null) // ni con un monto o método a mano
      assert.deepEqual(await txDe(a.id), [])
      assert.deepEqual(await movsDe(a.id_cliente), [])
      assert.equal(await saldoDe(a.id_cliente), 0)
      // sigue en Asignar precio, ahora como retirado
      const fila = (await filasSinPrecio()).find(f => f.id === a.id)
      assert.equal(fila.estado_asignar, 'retirado')
    })

    it('un grupo sin precio: retirar todos los contenedores tampoco cobra', async () => {
      const g = await grupoSinPrecio({ cuentaCorriente: true })
      for (const id of g.ops) {
        await AlquileresModel.devolverAPlanta(id)
        assert.equal(await AlquileresModel.cobrarAlCerrar(id), null)
      }
      assert.equal(await AlquileresModel.cobrarGrupo(g.id_grupo), null)
      for (const id of g.ops) assert.deepEqual(await txDe(id), [])
      assert.deepEqual(await movsDe(g.id_cliente), [])
    })

    it('el plazo por defecto sigue dependiendo de la cuenta corriente del cliente, sin método de pago', async () => {
      const { calcularPlazoAlquiler } = require('../src/config/alquiler')
      assert.equal(calcularPlazoAlquiler({ fechaInicio: haceDias(0), tieneCC: true }).plazo, 10)
      assert.equal(calcularPlazoAlquiler({ fechaInicio: haceDias(0), tieneCC: false }).plazo, 4)
    })
  })

  describe('Cobranzas → Asignar precio: listado', () => {
    it('lista cliente, OP, contenedor, dirección, inicio, estado, días y precio sugerido', async () => {
      const { precioDia } = await ConfigContenedoresModel.obtenerPrecios()
      const a = await enCurso({ dias: 3, plazo: 4 })
      const num = (await prueba.q(`SELECT numero_contenedor FROM contenedores WHERE id = ?`, [a.cont])).rows[0].numero_contenedor
      const f = (await filasSinPrecio()).find(x => x.id === a.id)
      assert.equal(f.cliente_nombre, 'PRUEBA GRUPOS')
      assert.equal(f.nro_op, a.nro_op)
      assert.equal(f.numero_contenedor, num)
      assert.equal(f.domicilio_entrega, 'San Lorenzo 501')
      assert.equal(f.fecha_inicio, a.inicio)
      assert.equal(f.estado_asignar, 'en_curso')
      assert.equal(f.dias, 3)
      assert.equal(f.plazo_alquiler, 4)
      assert.equal(f.precio_sugerido, 4 * precioDia)
      assert.equal(f.cliente_con_cc, false)
    })

    it('distingue pendiente / en curso / retirado y pone primero lo ya retirado', async () => {
      const p = await pendiente()
      const c = await enCurso()
      const r = await retirado()
      const ids = [p.id, c.id, r.id]
      const bloques = (await AlquileresModel.sinPrecio()).filter(b => b.filas.some(f => ids.includes(f.id)))
      assert.deepEqual(bloques.map(b => b.filas[0].estado_asignar), ['retirado', 'en_curso', 'pendiente'])
      assert.equal(bloques[2].filas[0].dias, null) // el pendiente todavía no tiene días
    })

    it('el precio sugerido es el plazo del alta a la tarifa por días (desde 9 días, el precio base)', async () => {
      const { precioDia, precioAlquiler } = await ConfigContenedoresModel.obtenerPrecios()
      const sugerido = async (opts) => { const a = await enCurso(opts); return (await filasSinPrecio()).find(f => f.id === a.id).precio_sugerido }
      assert.equal(await sugerido({ plazo: 4 }), 4 * precioDia)
      assert.equal(await sugerido({ plazo: 8 }), 8 * precioDia)
      assert.equal(await sugerido({ plazo: 9 }), precioAlquiler)
      assert.equal(await sugerido({ plazo: 10 }), precioAlquiler)
    })

    it('si el plazo se amplía, el sugerido suma esos días', async () => {
      const { precioDia } = await ConfigContenedoresModel.obtenerPrecios()
      const a = await enCurso({ plazo: 4 })
      await AlquileresModel.ampliarPlazo(a.id, 3)
      assert.equal((await filasSinPrecio()).find(f => f.id === a.id).precio_sugerido, 7 * precioDia)
    })

    it('sin fecha de fin se sugiere por los días reales (hasta el retiro, si ya se retiró)', async () => {
      const { precioDia } = await ConfigContenedoresModel.obtenerPrecios()
      const a = await enCurso({ plazo: null, dias: 3 })
      const f = (await filasSinPrecio()).find(x => x.id === a.id)
      assert.equal(f.plazo_alquiler, null)
      assert.equal(f.precio_sugerido, 3 * precioDia)
    })

    it('no lista los anulados, los que ya tienen precio ni los "a convenir" de antes', async () => {
      const anulado = await pendiente()
      await AlquileresModel.anular(anulado.id)
      const conPrecio = await enCurso()
      await AlquileresModel.asignarPrecio(conPrecio.id, { precio: '100', metodo_pago: 'efectivo' })

      // "a convenir" ya cargado, como los de antes: con precio, método a definir, retirado
      const id_cliente = await datos.crearCliente()
      const [cont] = await datos.crearContenedores(1)
      const viejo = await AlquileresModel.crearEnCurso({
        ...datos.datosComunes({ id_cliente, id_administrativo: admin, metodo_pago: 'a_convenir', fecha_inicio: haceDias(5) }),
        id_contenedor: cont, plazo_alquiler: 4, precio_alquiler: 100,
      })
      await AlquileresModel.devolverAPlanta(viejo.id)

      const ids = (await filasSinPrecio()).map(f => f.id)
      assert.equal(ids.includes(anulado.id), false)
      assert.equal(ids.includes(conPrecio.id), false)
      assert.equal(ids.includes(viejo.id), false)
      // ...y los "a convenir" siguen en su sección, como hoy
      assert.equal((await AlquileresModel.pendientesDeCobro()).some(p => p.id === viejo.id), true)
    })

    it('un alquiler agrupado sin precio es un bloque "todo junto"; si un contenedor ya tiene precio, se asigna por separado', async () => {
      const g = await grupoSinPrecio({ n: 3 })
      const bloqueDe = async () => (await AlquileresModel.sinPrecio()).find(b => b.filas.some(f => f.id_grupo === g.id_grupo))
      let b = await bloqueDe()
      assert.equal(b.todoJunto, true)
      assert.equal(b.id_grupo, g.id_grupo)
      assert.deepEqual(b.filas.map(f => f.id), g.ops)
      assert.equal(b.filas[0].grupo_cant, 3)

      await AlquileresModel.asignarPrecio(g.ops[0], { precio: '100', metodo_pago: 'efectivo' })
      const restantes = (await AlquileresModel.sinPrecio()).filter(x => x.filas.some(f => f.id_grupo === g.id_grupo))
      assert.deepEqual(restantes.map(x => x.todoJunto), [false, false])
      assert.deepEqual(restantes.flatMap(x => x.filas.map(f => f.id)).sort((x, y) => x - y), [g.ops[1], g.ops[2]])
    })

    it('cuenta los alquileres sin precio para el aviso del listado', async () => {
      const antes = await AlquileresModel.cantidadSinPrecio()
      const a = await pendiente()
      await pendiente()
      assert.equal(await AlquileresModel.cantidadSinPrecio(), antes + 2)
      await AlquileresModel.asignarPrecio(a.id, { precio: '100', metodo_pago: 'efectivo' })
      assert.equal(await AlquileresModel.cantidadSinPrecio(), antes + 1)
    })
  })

  describe('asignar precio y método', () => {
    it('valida el precio: vacío, texto y negativo se rechazan', async () => {
      const a = await enCurso()
      await assert.rejects(AlquileresModel.asignarPrecio(a.id, { precio: '', metodo_pago: 'efectivo' }), /Ingresá el precio/)
      await assert.rejects(AlquileresModel.asignarPrecio(a.id, { precio: 'abc', metodo_pago: 'efectivo' }), /Ingresá el precio/)
      await assert.rejects(AlquileresModel.asignarPrecio(a.id, { precio: '-5', metodo_pago: 'efectivo' }), /negativo/)
      assert.equal((await detalle(a.id)).precio_alquiler, null)
    })

    it('valida el método: hay que elegir uno de la lista', async () => {
      const a = await enCurso()
      for (const metodo_pago of ['', undefined, 'bitcoin']) {
        await assert.rejects(AlquileresModel.asignarPrecio(a.id, { precio: '100', metodo_pago }), /Elegí un método de pago/)
      }
      assert.equal((await detalle(a.id)).precio_alquiler, null)
    })

    it('"a convenir", en curso: fija el precio sin cobrar; al retirar sin método queda en A convenir', async () => {
      const a = await enCurso({ dias: 6, plazo: 4 })
      const r = await AlquileresModel.asignarPrecio(a.id, { precio: '777', metodo_pago: 'a_convenir' })
      assert.deepEqual(r, { monto: 777, cobrado: false, retirado: false })
      const d = await detalle(a.id)
      assert.deepEqual([d.precio_alquiler, d.metodo_op, d.metodo_detalle], [777, 'a_convenir', 'a_convenir'])
      assert.equal(await estaEnAsignar(a.id), false)
      assert.equal((await AlquileresModel.pendientesDeCobro()).some(p => p.id === a.id), false) // todavía afuera

      await AlquileresModel.devolverAPlanta(a.id)
      assert.equal(await AlquileresModel.cobrarAlCerrar(a.id), null) // el chofer no manda método
      assert.deepEqual(await txDe(a.id), [])
      assert.equal((await AlquileresModel.pendientesDeCobro()).some(p => p.id === a.id), true)
      // Se resuelve con el precio asignado, no con el cálculo por días
      assert.equal(await AlquileresModel.cobrarAlCerrar(a.id, undefined, 'transferencia'), 777)
      assert.deepEqual((await txDe(a.id)).map(t => [t.monto, t.metodo_pago]), [[777, 'transferencia']])
      assert.equal((await AlquileresModel.pendientesDeCobro()).some(p => p.id === a.id), false)
    })

    it('"a convenir", ya retirado: no cobra y pasa directo a la sección A convenir', async () => {
      const a = await retirado({ cuentaCorriente: true })
      const r = await AlquileresModel.asignarPrecio(a.id, { precio: '1500', metodo_pago: 'a_convenir' })
      assert.deepEqual(r, { monto: 1500, cobrado: false, retirado: true })
      assert.deepEqual(await txDe(a.id), [])
      assert.deepEqual(await movsDe(a.id_cliente), [])
      assert.equal(await estaEnAsignar(a.id), false)
      assert.equal((await AlquileresModel.pendientesDeCobro()).some(p => p.id === a.id), true)
      assert.equal(await AlquileresModel.cobrarAlCerrar(a.id, undefined, 'cuenta_corriente'), 1500)
      assert.deepEqual(await movsDe(a.id_cliente), [{ tipo: 'deuda', monto: -1500, id_op_encabezado: a.id }])
    })

    it('cuenta corriente a un cliente que no la tiene: se rechaza con un mensaje claro y no cambia nada', async () => {
      const a = await retirado({ cuentaCorriente: false })
      await assert.rejects(AlquileresModel.asignarPrecio(a.id, { precio: '1000', metodo_pago: 'cuenta_corriente' }),
        /no tiene la cuenta corriente habilitada/)
      const d = await detalle(a.id)
      assert.deepEqual([d.precio_alquiler, d.metodo_op, d.precio_asignado_en], [null, null, null])
      assert.deepEqual(await txDe(a.id), [])
      assert.equal(await estaEnAsignar(a.id), true)
    })

    it('cuenta corriente a un cliente que la tiene: ya retirado, registra el cargo como hoy', async () => {
      const a = await retirado({ cuentaCorriente: true })
      const r = await AlquileresModel.asignarPrecio(a.id, { precio: '1000', metodo_pago: 'cuenta_corriente' })
      assert.deepEqual(r, { monto: 1000, cobrado: true, retirado: true })
      assert.deepEqual((await txDe(a.id)).map(t => [t.monto, t.metodo_pago]), [[1000, 'cuenta_corriente']])
      assert.deepEqual(await movsDe(a.id_cliente), [{ tipo: 'deuda', monto: -1000, id_op_encabezado: a.id }])
      assert.equal(await saldoDe(a.id_cliente), -1000)
    })

    it('saldo a favor: solo con saldo, y consume el crédito', async () => {
      const sin = await retirado({ saldo: 0 })
      await assert.rejects(AlquileresModel.asignarPrecio(sin.id, { precio: '1000', metodo_pago: 'saldo_a_favor' }), /no tiene saldo a favor/)

      const con = await retirado({ saldo: 5000 })
      await AlquileresModel.asignarPrecio(con.id, { precio: '1000', metodo_pago: 'saldo_a_favor' })
      assert.deepEqual(await movsDe(con.id_cliente), [{ tipo: 'uso_saldo_favor', monto: -1000, id_op_encabezado: con.id }])
      assert.equal(await saldoDe(con.id_cliente), 4000)
    })

    it('ya retirado: se cobra en el momento con el precio cargado, sin referencia a otro precio', async () => {
      const a = await retirado()
      const r = await AlquileresModel.asignarPrecio(a.id, { precio: '155000', metodo_pago: 'efectivo' })
      assert.deepEqual(r, { monto: 155000, cobrado: true, retirado: true })
      const tx = await txDe(a.id)
      assert.equal(tx.length, 1)
      assert.deepEqual([tx[0].monto, tx[0].metodo_pago], [155000, 'efectivo'])
      assert.match(tx[0].descripcion, /^Alquiler contenedor #\d+ — San Lorenzo 501$/)
      const d = await detalle(a.id)
      assert.deepEqual([d.precio_alquiler, d.metodo_op, d.metodo_detalle], [155000, 'efectivo', 'efectivo'])
      assert.match(d.precio_asignado_en, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
      assert.equal(await estaEnAsignar(a.id), false)
    })

    it('en curso: se guardan precio y método y NO se cobra; al retirar se cobra el precio asignado, no el cálculo por días', async () => {
      const a = await enCurso({ dias: 6, plazo: 4 })
      const r = await AlquileresModel.asignarPrecio(a.id, { precio: '777', metodo_pago: 'transferencia' })
      assert.deepEqual(r, { monto: 777, cobrado: false, retirado: false })
      assert.deepEqual(await txDe(a.id), [])
      const cierre = await AlquileresModel.datosCierre(a.id)
      assert.equal(cierre.precioAsignado, true)
      assert.equal(cierre.precioACobrar, 777)
      assert.notEqual(cierre.precioActual, 777) // el cálculo por días daría otra cosa

      await AlquileresModel.devolverAPlanta(a.id)
      assert.equal(await AlquileresModel.cobrarAlCerrar(a.id), 777) // retira el chofer: no manda monto
      assert.deepEqual((await txDe(a.id)).map(t => [t.monto, t.metodo_pago]), [[777, 'transferencia']])
    })

    it('en curso: la oficina puede ajustar el monto al retirar', async () => {
      const a = await enCurso()
      await AlquileresModel.asignarPrecio(a.id, { precio: '777', metodo_pago: 'efectivo' })
      await AlquileresModel.devolverAPlanta(a.id)
      assert.equal(await AlquileresModel.cobrarAlCerrar(a.id, '800'), 800)
      assert.deepEqual((await txDe(a.id)).map(t => t.monto), [800])
    })

    it('todavía sin entregar (pendiente): se guarda y se cobra al retirar', async () => {
      const a = await pendiente({ cuentaCorriente: true })
      const r = await AlquileresModel.asignarPrecio(a.id, { precio: '500', metodo_pago: 'cuenta_corriente' })
      assert.equal(r.cobrado, false)
      assert.deepEqual(await txDe(a.id), [])
      await AlquileresModel.entregar(a.id)
      await AlquileresModel.devolverAPlanta(a.id)
      assert.equal(await AlquileresModel.cobrarAlCerrar(a.id), 500)
      assert.deepEqual(await movsDe(a.id_cliente), [{ tipo: 'deuda', monto: -500, id_op_encabezado: a.id }])
    })

    it('un precio cero (sin cargo) es válido: deja de estar "sin precio" y se cobra $0 al retirar', async () => {
      const a = await enCurso()
      const r = await AlquileresModel.asignarPrecio(a.id, { precio: '0', metodo_pago: 'efectivo' })
      assert.deepEqual(r, { monto: 0, cobrado: false, retirado: false })
      assert.equal((await detalle(a.id)).precio_alquiler, 0)
      assert.equal(await estaEnAsignar(a.id), false)
      await AlquileresModel.devolverAPlanta(a.id)
      assert.equal(await AlquileresModel.cobrarAlCerrar(a.id), 0)
      assert.deepEqual((await txDe(a.id)).map(t => t.monto), [0])
    })

    it('asignar dos veces se rechaza y no duplica el cobro', async () => {
      const a = await retirado()
      await AlquileresModel.asignarPrecio(a.id, { precio: '100', metodo_pago: 'efectivo' })
      await assert.rejects(AlquileresModel.asignarPrecio(a.id, { precio: '999', metodo_pago: 'efectivo' }), /ya tiene precio asignado/)
      assert.deepEqual((await txDe(a.id)).map(t => t.monto), [100])
      assert.equal((await detalle(a.id)).precio_alquiler, 100)
    })

    it('un alquiler anulado o inexistente no se puede asignar', async () => {
      const a = await pendiente()
      await AlquileresModel.anular(a.id)
      await assert.rejects(AlquileresModel.asignarPrecio(a.id, { precio: '100', metodo_pago: 'efectivo' }), /anulado/)
      await assert.rejects(AlquileresModel.asignarPrecio(2147483000, { precio: '100', metodo_pago: 'efectivo' }), /no encontrado/)
    })
  })

  describe('alquileres de varios contenedores', () => {
    it('por contenedor: cada uno se asigna por separado, con su método, y se cobra a su retiro', async () => {
      const g = await grupoSinPrecio({ cuentaCorriente: true })
      await AlquileresModel.asignarPrecio(g.ops[0], { precio: '100', metodo_pago: 'efectivo' })
      await AlquileresModel.asignarPrecio(g.ops[1], { precio: '150', metodo_pago: 'cuenta_corriente' })
      assert.equal((await prueba.q(`SELECT cobro_modo FROM alquiler_grupos WHERE id = ?`, [g.id_grupo])).rows[0].cobro_modo, 'contenedor')

      await AlquileresModel.devolverAPlanta(g.ops[0])
      assert.equal(await AlquileresModel.cobrarAlCerrar(g.ops[0]), 100)
      assert.deepEqual([(await txDe(g.ops[0])).length, (await txDe(g.ops[1])).length], [1, 0])
      await AlquileresModel.devolverAPlanta(g.ops[1])
      assert.equal(await AlquileresModel.cobrarAlCerrar(g.ops[1]), 150)
      assert.deepEqual(await movsDe(g.id_cliente), [{ tipo: 'deuda', monto: -150, id_op_encabezado: g.ops[1] }])
    })

    it('todo junto, ya retirados: pasa a cobro por alquiler, una transacción por OP y un solo cargo por el total', async () => {
      const g = await grupoSinPrecio({ cuentaCorriente: true })
      for (const id of g.ops) await AlquileresModel.devolverAPlanta(id)
      const r = await AlquileresModel.asignarPrecioGrupo(g.ops[0], {
        precios: { [g.ops[0]]: '100', [g.ops[1]]: '250' }, metodo_pago: 'cuenta_corriente',
      })
      assert.deepEqual(r, { total: 350, cobrado: true })
      assert.equal((await prueba.q(`SELECT cobro_modo FROM alquiler_grupos WHERE id = ?`, [g.id_grupo])).rows[0].cobro_modo, 'alquiler')
      assert.deepEqual([(await txDe(g.ops[0]))[0].monto, (await txDe(g.ops[1]))[0].monto], [100, 250])
      assert.deepEqual((await txDe(g.ops[0]))[0].metodo_pago, 'cuenta_corriente')
      assert.deepEqual(await movsDe(g.id_cliente), [{ tipo: 'deuda', monto: -350, id_op_encabezado: g.ops[0] }]) // uno solo, anclado a la OP principal
      assert.equal(await saldoDe(g.id_cliente), -350)
      for (const id of g.ops) assert.deepEqual([(await detalle(id)).metodo_op, (await detalle(id)).metodo_detalle], ['cuenta_corriente', 'cuenta_corriente'])
    })

    it('todo junto con un contenedor todavía afuera: no cobra; se cobra todo junto al retirar el último, con los precios asignados', async () => {
      const g = await grupoSinPrecio({ cuentaCorriente: true, dias: 6 })
      await AlquileresModel.devolverAPlanta(g.ops[0])
      const r = await AlquileresModel.asignarPrecioGrupo(g.ops[0], {
        precios: { [g.ops[0]]: '100', [g.ops[1]]: '250' }, metodo_pago: 'cuenta_corriente',
      })
      assert.deepEqual(r, { total: 350, cobrado: false })
      assert.deepEqual([(await txDe(g.ops[0])).length, (await movsDe(g.id_cliente)).length], [0, 0])

      assert.equal(await AlquileresModel.cobrarAlCerrar(g.ops[0]), null) // el primero ya estaba retirado: falta el otro
      await AlquileresModel.devolverAPlanta(g.ops[1])
      assert.equal(await AlquileresModel.cobrarAlCerrar(g.ops[1]), 350)
      assert.deepEqual([(await txDe(g.ops[0]))[0].monto, (await txDe(g.ops[1]))[0].monto], [100, 250])
      assert.deepEqual(await movsDe(g.id_cliente), [{ tipo: 'deuda', monto: -350, id_op_encabezado: g.ops[0] }])
    })

    it('todo junto "a convenir": no cobra al retirar el último; queda una sola fila en A convenir y se cobra con los precios asignados', async () => {
      const g = await grupoSinPrecio({ cuentaCorriente: true, dias: 6 })
      const r = await AlquileresModel.asignarPrecioGrupo(g.ops[0], {
        precios: { [g.ops[0]]: '100', [g.ops[1]]: '250' }, metodo_pago: 'a_convenir',
      })
      assert.deepEqual(r, { total: 350, cobrado: false })
      for (const id of g.ops) await AlquileresModel.devolverAPlanta(id)
      assert.equal(await AlquileresModel.cobrarAlCerrar(g.ops[1]), null)
      const filas = (await AlquileresModel.pendientesDeCobro()).filter(p => p.id_grupo === g.id_grupo)
      assert.equal(filas.length, 1)
      assert.equal(await AlquileresModel.cobrarAlCerrar(g.ops[1], undefined, 'cuenta_corriente'), 350)
      assert.deepEqual([(await txDe(g.ops[0]))[0].monto, (await txDe(g.ops[1]))[0].monto], [100, 250])
      assert.deepEqual(await movsDe(g.id_cliente), [{ tipo: 'deuda', monto: -350, id_op_encabezado: g.ops[0] }])
    })

    it('todo junto: si falta el precio de un contenedor, o es inválido, no se asigna nada', async () => {
      const g = await grupoSinPrecio()
      await assert.rejects(AlquileresModel.asignarPrecioGrupo(g.ops[0], { precios: { [g.ops[0]]: '100' }, metodo_pago: 'efectivo' }),
        /Ingresá el precio del contenedor/)
      await assert.rejects(AlquileresModel.asignarPrecioGrupo(g.ops[0], { precios: { [g.ops[0]]: '100', [g.ops[1]]: '-1' }, metodo_pago: 'efectivo' }),
        /Ingresá el precio del contenedor/)
      for (const id of g.ops) assert.equal((await detalle(id)).precio_alquiler, null)
      assert.equal((await prueba.q(`SELECT cobro_modo FROM alquiler_grupos WHERE id = ?`, [g.id_grupo])).rows[0].cobro_modo, 'contenedor')
    })

    it('todo junto: cuenta corriente solo si el cliente la tiene', async () => {
      const g = await grupoSinPrecio({ cuentaCorriente: false })
      await assert.rejects(AlquileresModel.asignarPrecioGrupo(g.ops[0], {
        precios: { [g.ops[0]]: '100', [g.ops[1]]: '100' }, metodo_pago: 'cuenta_corriente',
      }), /no tiene la cuenta corriente habilitada/)
      for (const id of g.ops) assert.equal((await detalle(id)).precio_alquiler, null)
    })

    it('todo junto no se puede si algún contenedor ya tiene precio, y no vale para un alquiler de un solo contenedor', async () => {
      const g = await grupoSinPrecio()
      await AlquileresModel.asignarPrecio(g.ops[0], { precio: '100', metodo_pago: 'efectivo' })
      await assert.rejects(AlquileresModel.asignarPrecioGrupo(g.ops[1], {
        precios: { [g.ops[0]]: '1', [g.ops[1]]: '2' }, metodo_pago: 'efectivo',
      }), /asignalos de a uno/)
      const solo = await enCurso()
      await assert.rejects(AlquileresModel.asignarPrecioGrupo(solo.id, { precios: { [solo.id]: '1' }, metodo_pago: 'efectivo' }), /no es de varios contenedores/)
    })

    it('un contenedor anulado del grupo no cuenta al asignar todo junto', async () => {
      // Pendientes (todavía sin entregar), que es cuando una OP se puede anular
      const id_cliente = await datos.crearCliente()
      const conts = await datos.crearContenedores(3)
      const p = await AlquileresModel.crearGrupo({
        ...comunes(id_cliente, -3), contenedores: conts.map(id_contenedor => ({ id_contenedor, plazo_alquiler: 4 })),
      })
      await AlquileresModel.anular(p.ops[2].id)
      const b = (await AlquileresModel.sinPrecio()).find(x => x.filas.some(f => f.id_grupo === p.id_grupo))
      assert.equal(b.todoJunto, true)
      assert.equal(b.filas.length, 2)
      const r = await AlquileresModel.asignarPrecioGrupo(p.ops[0].id, {
        precios: { [p.ops[0].id]: '100', [p.ops[1].id]: '200' }, metodo_pago: 'efectivo',
      })
      assert.equal(r.total, 300)
      assert.equal((await detalle(p.ops[2].id)).precio_alquiler, null) // el anulado queda como estaba
    })

    it('un contenedor suelto de un grupo que ya se cobra por alquiler no se asigna por separado', async () => {
      const g = await grupoSinPrecio()
      await prueba.q(`UPDATE alquiler_grupos SET cobro_modo = 'alquiler' WHERE id = ?`, [g.id_grupo])
      await assert.rejects(AlquileresModel.asignarPrecio(g.ops[0], { precio: '100', metodo_pago: 'efectivo' }), /por alquiler/)
    })
  })

  describe('edición', () => {
    const datosEdicion = (extra = {}) => ({
      calle: 'San Lorenzo', numero: '501', zona_entrega: '', plazo_alquiler: 4, observaciones: 'edit',
      fecha_entrega_planificada: haceDias(3), obra: '', ...extra,
    })

    it('editar un alquiler sin precio no le pone $0 ni método de pago, aunque el formulario los mande', async () => {
      const a = await enCurso()
      await AlquileresModel.actualizar(a.id, datosEdicion())
      let d = await detalle(a.id)
      assert.deepEqual([d.precio_alquiler, d.metodo_op, d.metodo_detalle], [null, null, null])
      await AlquileresModel.actualizar(a.id, datosEdicion({ precio_alquiler: '999', metodo_pago: 'efectivo' }))
      d = await detalle(a.id)
      assert.deepEqual([d.precio_alquiler, d.metodo_op, d.metodo_detalle], [null, null, null])
      assert.equal(await estaEnAsignar(a.id), true)
    })

    it('editar un alquiler con precio sigue como siempre', async () => {
      const id_cliente = await datos.crearCliente()
      const [cont] = await datos.crearContenedores(1)
      const r = await AlquileresModel.crearEnCurso({
        ...datos.datosComunes({ id_cliente, id_administrativo: admin, metodo_pago: 'efectivo', fecha_inicio: haceDias(3) }),
        id_contenedor: cont, plazo_alquiler: 4, precio_alquiler: 100,
      })
      await AlquileresModel.actualizar(r.id, datosEdicion({ precio_alquiler: '250', metodo_pago: 'transferencia', observaciones: 'otra' }))
      const d = await detalle(r.id)
      assert.deepEqual([d.precio_alquiler, d.metodo_op, d.metodo_detalle], [250, 'transferencia', 'transferencia'])
    })

    it('"aplicar a todos" no le copia método de pago a un contenedor que todavía no tiene precio', async () => {
      const g = await grupoSinPrecio()
      await AlquileresModel.asignarPrecio(g.ops[0], { precio: '100', metodo_pago: 'efectivo' })
      assert.equal(await AlquileresModel.actualizarCompartidosGrupo(g.ops[0]), 1)
      assert.equal((await detalle(g.ops[1])).metodo_op, null)
      assert.equal((await detalle(g.ops[1])).metodo_detalle, null)
    })
  })

  describe('los alquileres ya cargados siguen como hoy', () => {
    it('con precio de alta: al retirar se cobra la tarifa por días, no el precio cargado', async () => {
      const { precioDia } = await ConfigContenedoresModel.obtenerPrecios()
      const id_cliente = await datos.crearCliente()
      const [cont] = await datos.crearContenedores(1)
      const r = await AlquileresModel.crearEnCurso({
        ...datos.datosComunes({ id_cliente, id_administrativo: admin, metodo_pago: 'efectivo', fecha_inicio: haceDias(6) }),
        id_contenedor: cont, plazo_alquiler: 4, precio_alquiler: 100,
      })
      const cierre = await AlquileresModel.datosCierre(r.id)
      assert.deepEqual([cierre.sinPrecio, cierre.precioAsignado, cierre.precioACobrar, cierre.precioActual], [false, false, 6 * precioDia, 6 * precioDia])
      assert.equal(cierre.cambioDePrecio, true) // se muestra el precio pactado como referencia
      await AlquileresModel.devolverAPlanta(r.id)
      assert.equal(await AlquileresModel.cobrarAlCerrar(r.id), 6 * precioDia)
      assert.match((await txDe(r.id))[0].descripcion, /\(Precio inicial .+: \$100\)$/)
    })

    it('con precio cero cargado en el alta: no es "sin precio" y se cobra por días como siempre', async () => {
      const { precioDia } = await ConfigContenedoresModel.obtenerPrecios()
      const id_cliente = await datos.crearCliente()
      const [cont] = await datos.crearContenedores(1)
      const r = await AlquileresModel.crearEnCurso({
        ...datos.datosComunes({ id_cliente, id_administrativo: admin, metodo_pago: 'efectivo', fecha_inicio: haceDias(2) }),
        id_contenedor: cont, plazo_alquiler: 4, precio_alquiler: 0,
      })
      assert.equal(await estaEnAsignar(r.id), false)
      await AlquileresModel.devolverAPlanta(r.id)
      assert.equal(await AlquileresModel.cobrarAlCerrar(r.id), 2 * precioDia)
    })

    it('"a convenir" con precio: sin método queda pendiente y con método se cobra por días', async () => {
      const { precioDia } = await ConfigContenedoresModel.obtenerPrecios()
      const id_cliente = await datos.crearCliente()
      const [cont] = await datos.crearContenedores(1)
      const r = await AlquileresModel.crearEnCurso({
        ...datos.datosComunes({ id_cliente, id_administrativo: admin, metodo_pago: 'a_convenir', fecha_inicio: haceDias(3) }),
        id_contenedor: cont, plazo_alquiler: 4, precio_alquiler: 100,
      })
      await AlquileresModel.devolverAPlanta(r.id)
      assert.equal(await AlquileresModel.cobrarAlCerrar(r.id), null)
      assert.equal(await AlquileresModel.cobrarAlCerrar(r.id, undefined, 'efectivo'), 3 * precioDia)
    })
  })

  describe('totales, estimaciones y comprobantes', () => {
    it('el libro de ventas tolera un alquiler sin precio (importe 0) y toma el precio una vez asignado', async () => {
      const a = await enCurso({ dias: 3 })
      const libro = async () => (await ReportesModel.libroVentas({ desde: a.inicio, hasta: a.inicio, clienteId: a.id_cliente }))
      let l = await libro()
      assert.equal(l.filas.length, 1)
      assert.equal(l.filas[0].importe, 0)
      assert.equal(l.total, 0)
      await AlquileresModel.asignarPrecio(a.id, { precio: '1234', metodo_pago: 'efectivo' })
      l = await libro()
      assert.deepEqual([l.filas[0].importe, l.total], [1234, 1234])
    })

    it('facturación: "para facturar" sin precio no tapa el precio asignado después', async () => {
      const a = await enCurso({ dias: 3 })
      await FacturacionModel.marcarAlCrear(a.id, '1', null)
      assert.equal((await prueba.q(`SELECT monto_facturar FROM op_encabezado WHERE id = ?`, [a.id])).rows[0].monto_facturar, null)
      assert.equal((await FacturacionModel.estadoOp(a.id)).monto, 0)
      await AlquileresModel.asignarPrecio(a.id, { precio: '777', metodo_pago: 'efectivo' })
      assert.equal((await FacturacionModel.estadoOp(a.id)).monto, 777)
      await AlquileresModel.devolverAPlanta(a.id)
      await AlquileresModel.cobrarAlCerrar(a.id)
      assert.equal((await FacturacionModel.estadoOp(a.id)).monto, 777)
    })

    it('facturación: con un monto cargado se guarda como siempre', async () => {
      const a = await enCurso()
      await FacturacionModel.marcarAlCrear(a.id, '1', 500)
      assert.equal((await prueba.q(`SELECT monto_facturar FROM op_encabezado WHERE id = ?`, [a.id])).rows[0].monto_facturar, 500)
    })

    it('cuenta corriente: un alquiler sin precio no aparece; asignado a cuenta corriente y en curso, se estima con su precio', async () => {
      const a = await enCurso({ cuentaCorriente: true })
      assert.deepEqual(await ClientesModel.operacionesSinCargo(a.id_cliente), [])
      await AlquileresModel.asignarPrecio(a.id, { precio: '4321', metodo_pago: 'cuenta_corriente' })
      const lista = await ClientesModel.operacionesSinCargo(a.id_cliente)
      assert.deepEqual(lista.map(o => [o.id, o.precio_alquiler]), [[a.id, 4321]])
      assert.equal((await AlquileresModel.datosCierre(a.id)).precioACobrar, 4321)
    })

    it('retirar un alquiler sin precio no mueve los totales de transacciones', async () => {
      const a = await enCurso()
      const antes = await TransaccionesModel.resumen({ clienteId: a.id_cliente })
      await AlquileresModel.devolverAPlanta(a.id)
      await AlquileresModel.cobrarAlCerrar(a.id)
      const despues = await TransaccionesModel.resumen({ clienteId: a.id_cliente })
      assert.deepEqual([despues.total, despues.count], [antes.total, antes.count])
      assert.equal(despues.count, 0)
    })

    // Textos que el PDF del remito dibuja (el contenido va comprimido: se intercepta pdfkit)
    async function textosDelPdf(remito) {
      const PDFDocument = require('pdfkit')
      const original = PDFDocument.prototype.text
      const textos = []
      PDFDocument.prototype.text = function (t, ...resto) { textos.push(String(t)); return original.call(this, t, ...resto) }
      try {
        const buffer = await generarRemitoPDFBuffer(remito)
        assert.equal(buffer.subarray(0, 4).toString(), '%PDF')
      } finally { PDFDocument.prototype.text = original }
      return textos
    }

    it('el remito dice "A definir" mientras no hay precio (no $0), y muestra el importe una vez asignado', async () => {
      const a = await enCurso()
      let r = await RemitosModel.obtener(a.id)
      assert.deepEqual([r.items[0].sinPrecio, r.sinPrecio, r.total], [true, true, 0])
      let textos = await textosDelPdf(r)
      assert.equal(textos.filter(t => t === 'A definir').length, 3) // precio unitario, subtotal y total
      assert.equal(textos.some(t => t.startsWith('$')), false)

      await AlquileresModel.asignarPrecio(a.id, { precio: '900', metodo_pago: 'efectivo' })
      r = await RemitosModel.obtener(a.id)
      assert.deepEqual([r.items[0].sinPrecio, r.sinPrecio, r.total], [false, false, 900])
      textos = await textosDelPdf(r)
      assert.equal(textos.includes('A definir'), false)
      assert.equal(textos.filter(t => t === '$900,00').length, 3)
    })
  })
})
