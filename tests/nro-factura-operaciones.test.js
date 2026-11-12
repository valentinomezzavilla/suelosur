'use strict'
// N° de Factura en TODAS las operaciones (venta de cantera, venta con viaje, alquiler de
// contenedor y alquiler de maquinaria), estén o no marcadas "Para facturar":
//  - se carga, corrige o borra desde un botón en la columna de acciones de cada listado
//    ("Agregar N°Factura" / "Editar N°Factura") y desde la pantalla de edición;
//  - una operación ya facturada (el número es el de su comprobante) o anulada no se toca;
//  - sacarla de "Para facturar" ya no borra el número.
// Corre dentro de la transacción de prueba (ROLLBACK al final: nada queda guardado).
const prueba = require('./helpers/db')
const datos = require('./helpers/datos')
const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { renderVista } = require('./helpers/vistas')
const VentasModel = require('../src/models/ventas.model')
const VentasController = require('../src/controllers/ventas.controller')
const FacturacionController = require('../src/controllers/facturacion.controller')
const FacturacionModel = require('../src/models/facturacion.model')
const AlquileresModel = require('../src/models/alquileres.model')
const AlquileresController = require('../src/controllers/alquileres.controller')
const AlquileresMaquinariaModel = require('../src/models/alquileres_maquinaria.model')
const AlquileresMaquinariaController = require('../src/controllers/alquileres_maquinaria.controller')

function llamar(Controller, accion, { body = {}, params = {}, query = {}, user }) {
  return new Promise((resolve, reject) => {
    const flashes = []
    const req = { body, params, query, session: { user }, flash: (tipo, msg) => flashes.push({ tipo, msg }), get: () => null }
    const res = { locals: {}, redirect: (url) => resolve({ url, flashes }), render: (vista, data) => resolve({ vista, data, flashes }), status: () => res }
    Promise.resolve(Controller[accion](req, res)).catch(reject)
  })
}

// Botones de solo ícono (.btn-icon): cada uno con nombre accesible (aria-label, igual al tooltip) y
// ninguno con texto visible. Devuelve cuántos hay.
function revisarIconos(html) {
  const botones = html.match(/<(button|a)\b[^>]*\bbtn-icon\b[^>]*>[\s\S]*?<\/\1>/g) || []
  for (const b of botones) {
    const etiqueta = (b.match(/aria-label="([^"]+)"/) || [])[1]
    assert.ok(etiqueta, 'botón de ícono sin aria-label: ' + b.slice(0, 120))
    assert.equal((b.match(/\btitle="([^"]*)"/) || [])[1], etiqueta, 'el tooltip (title) tiene que ser el mismo nombre: ' + etiqueta)
    assert.match(b, /data-bs-toggle="tooltip"/)
    assert.equal(b.replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]*>/g, '').trim(), '', 'el botón "' + etiqueta + '" no debe llevar texto visible')
  }
  return botones.length
}

describe('N° de Factura en cualquier operación', () => {
  let admin, user, producto, cliente

  before(async () => {
    await prueba.abrir()
    admin = await datos.idAdministrativo()
    user = { id: admin, rol: 'dueno' }
    producto = (await prueba.q(`INSERT INTO productos (nombre, unidad_medida, precio_cantera, precio_viaje, activo, depende_stock)
      VALUES ('Arena prueba nro factura todas', 'm³', 1000, 1200, 1, 0) RETURNING id`)).rows[0].id
    cliente = await datos.crearCliente()
  })
  after(() => prueba.cerrar())

  // Una operación de cada tipo
  const cantera = async () => {
    const r = await llamar(VentasController, 'finalizarCantera', { user, body: {
      clienteId: String(cliente), clienteNombre: 'PRUEBA', metodoPago: 'efectivo', items: JSON.stringify([{ id: producto, cantidad: 2 }]),
    } })
    assert.ok(!r.flashes.some(f => f.tipo === 'error'), JSON.stringify(r.flashes))
    return (await prueba.q(`SELECT id FROM op_encabezado WHERE id_cliente = ? ORDER BY id DESC LIMIT 1`, [cliente])).rows[0].id
  }
  const viaje = async () => (await VentasModel.crear({
    id_cliente: cliente, id_administrativo: admin, tipo_op: 'M', modalidad: 'flete', metodo_pago: 'efectivo',
    fecha_emision: '2026-11-10', fecha_entrega_planificada: '2026-11-20', domicilio: { calle: 'Colón', altura: '100' }, obra: null,
    precio_flete: 0, monto_total: 1000, detalles: [{ id_producto: producto, cantidad_pedida: 1, precio_unitario: 1000 }],
  })).id
  const alquiler = async () => {
    const [cont] = await datos.crearContenedores(1)
    return (await AlquileresModel.crear({ ...datos.datosComunes({ id_cliente: cliente, id_administrativo: admin }), id_contenedor: cont, plazo_alquiler: 4, precio_alquiler: 100 })).id
  }
  const maquinaria = async () => (await AlquileresMaquinariaModel.crear({
    ...datos.datosComunes({ id_cliente: cliente, id_administrativo: admin }),
    id_maquinaria: null, id_chofer: null, plazo_alquiler: 1, precio_por_hora: 100, horas_pactadas: 2, precio_total: 200,
  })).id
  const TIPOS = [['venta de cantera', cantera], ['venta con viaje', viaje], ['alquiler de contenedor', alquiler], ['alquiler de maquinaria', maquinaria]]

  const fila = async (id) => (await prueba.q(`SELECT nro_factura, para_facturar, facturado, iva_alicuota, estado FROM op_encabezado WHERE id = ?`, [id])).rows[0]
  const guardar = (id, nroFactura, extra = {}) => llamar(FacturacionController, 'nroFactura', { user, params: { id }, body: { nroFactura, ...extra } })

  describe('desde el botón de la fila (POST /facturacion/:id/nro-factura)', () => {
    for (const [nombre, crear] of TIPOS) {
      it(`${nombre}: se carga sin marcarla para facturar, se corrige y se borra`, async () => {
        const id = await crear()
        let r = await guardar(id, '  0001-00000042 ', { volver: '/ventas?page=2' })
        assert.equal(r.url, '/ventas?page=2')
        assert.equal(r.flashes[0].tipo, 'success', JSON.stringify(r.flashes))
        let op = await fila(id)
        assert.equal(op.nro_factura, '0001-00000042')
        assert.ok(!Number(op.para_facturar), 'cargar el número no la marca para facturar')
        assert.ok(!Number(op.iva_alicuota), 'ni le suma IVA')
        await guardar(id, '0001-00000043')
        assert.equal((await fila(id)).nro_factura, '0001-00000043')
        r = await guardar(id, '   ')
        assert.match(r.flashes[0].msg, /Se quitó/)
        assert.equal((await fila(id)).nro_factura, null)
      })
    }

    it('también sigue valiendo en una operación marcada para facturar', async () => {
      const id = await cantera()
      await llamar(FacturacionController, 'marcar', { user, params: { id }, body: {} })
      await guardar(id, 'A-0001-7')
      const op = await fila(id)
      assert.equal(op.nro_factura, 'A-0001-7')
      assert.equal(Number(op.para_facturar), 1)
    })

    it('una operación ya facturada no cambia su número: es el de su comprobante', async () => {
      const id = await cantera()
      await prueba.q(`UPDATE op_encabezado SET facturado = 1, nro_factura = 'A-1' WHERE id = ?`, [id])
      const r = await guardar(id, 'otro')
      assert.equal(r.flashes[0].tipo, 'error')
      assert.match(r.flashes[0].msg, /ya está facturada/)
      assert.equal((await fila(id)).nro_factura, 'A-1')
    })

    it('una operación anulada tampoco', async () => {
      const id = await cantera()
      await prueba.q(`UPDATE op_encabezado SET estado = 'anulado' WHERE id = ?`, [id])
      const r = await guardar(id, '0001-1')
      assert.match(r.flashes[0].msg, /anulada/)
      assert.equal((await fila(id)).nro_factura, null)
    })

    it('una operación que no existe avisa y no rompe', async () => {
      const r = await guardar(987654321, '0001-1')
      assert.equal(r.flashes[0].tipo, 'error')
      assert.match(r.flashes[0].msg, /no se encontró/i)
    })

    it('sacarla de "Para facturar" ya no borra el número', async () => {
      const id = await cantera()
      await llamar(FacturacionController, 'marcar', { user, params: { id }, body: { nroFactura: '0002-00000001' } })
      await llamar(FacturacionController, 'quitar', { user, params: { id }, body: {} })
      const op = await fila(id)
      assert.equal(Number(op.para_facturar), 0)
      assert.equal(op.nro_factura, '0002-00000001')
    })

    it('marcar una que ya tenía número sin escribir otro conserva el que tenía', async () => {
      const id = await cantera()
      await guardar(id, '0003-00000009')
      await llamar(FacturacionController, 'marcar', { user, params: { id }, body: {} })
      assert.equal((await fila(id)).nro_factura, '0003-00000009')
    })

    it('se busca por el número en Ventas aunque no esté marcada para facturar', async () => {
      const id = await cantera()
      await guardar(id, 'ZZ-777')
      const v = await llamar(VentasController, 'index', { user, query: { q: 'ZZ-777' } })
      assert.deepEqual(v.data.ops.map(o => Number(o.id)), [Number(id)])
    })
  })

  describe('desde la edición de la operación', () => {
    it('venta con viaje: el número viaja con el resto de los datos', async () => {
      const id = await viaje()
      await VentasModel.actualizarViaje(id, { calle: 'Colón', numero: '100', fecha: '2026-11-21', metodoPago: 'efectivo', nroFactura: ' 0001-00000050 ' })
      assert.equal((await fila(id)).nro_factura, '0001-00000050')
      await VentasModel.actualizarViaje(id, { calle: 'Colón', numero: '100', fecha: '2026-11-21', metodoPago: 'efectivo', nroFactura: '' })
      assert.equal((await fila(id)).nro_factura, null)
    })

    it('venta con viaje: si el formulario no trae el campo, el número no se toca', async () => {
      const id = await viaje()
      await guardar(id, '0001-00000051')
      await VentasModel.actualizarViaje(id, { calle: 'Colón', numero: '100', fecha: '2026-11-21', metodoPago: 'efectivo' })
      assert.equal((await fila(id)).nro_factura, '0001-00000051')
    })

    it('venta con viaje: facturada no se puede cambiar y no se guarda nada de la edición', async () => {
      const id = await viaje()
      await prueba.q(`UPDATE op_encabezado SET facturado = 1, nro_factura = 'A-9' WHERE id = ?`, [id])
      await assert.rejects(() => VentasModel.actualizarViaje(id, { calle: 'Otra', numero: '1', fecha: '2026-11-21', metodoPago: 'efectivo', nroFactura: 'X' }), /ya está facturada/)
      const op = (await prueba.q(`SELECT nro_factura, domicilio_calle FROM op_encabezado WHERE id = ?`, [id])).rows[0]
      assert.equal(op.nro_factura, 'A-9')
      assert.equal(op.domicilio_calle, 'Colón', 'la edición completa se deshizo')
    })

    const edicionAlquiler = { calle: 'San Lorenzo', numero: '501', zona_entrega: '', plazo_alquiler: 4, precio_alquiler: 100, metodo_pago: 'efectivo', observaciones: 'x', fecha_entrega_planificada: '2026-11-20', obra: '' }
    it('alquiler de contenedor: se guarda y se borra con la edición', async () => {
      const id = await alquiler()
      await AlquileresModel.actualizar(id, { ...edicionAlquiler, nroFactura: '0004-00000001' })
      assert.equal((await fila(id)).nro_factura, '0004-00000001')
      await AlquileresModel.actualizar(id, { ...edicionAlquiler, nroFactura: '' })
      assert.equal((await fila(id)).nro_factura, null)
    })
    it('alquiler de contenedor: sin el campo no se toca', async () => {
      const id = await alquiler()
      await guardar(id, '0004-00000002')
      await AlquileresModel.actualizar(id, edicionAlquiler)
      assert.equal((await fila(id)).nro_factura, '0004-00000002')
    })

    const edicionMaq = { calle: 'San Lorenzo', numero: '501', zona_entrega: '', plazo_alquiler: 1, precio_por_hora: 100, horas_pactadas: 2, precio_total: 200, metodo_pago: 'efectivo', observaciones: 'x', fecha_entrega_planificada: '2026-11-20' }
    it('alquiler de maquinaria: se guarda y se borra con la edición', async () => {
      const id = await maquinaria()
      await AlquileresMaquinariaModel.actualizar(id, { ...edicionMaq, nroFactura: '0005-00000001' })
      assert.equal((await fila(id)).nro_factura, '0005-00000001')
      await AlquileresMaquinariaModel.actualizar(id, { ...edicionMaq, nroFactura: '' })
      assert.equal((await fila(id)).nro_factura, null)
    })
    it('alquiler de maquinaria: sin el campo no se toca', async () => {
      const id = await maquinaria()
      await guardar(id, '0005-00000002')
      await AlquileresMaquinariaModel.actualizar(id, edicionMaq)
      assert.equal((await fila(id)).nro_factura, '0005-00000002')
    })
  })

  describe('botón en la columna de acciones', () => {
    // El botón es de solo ícono: su nombre es el aria-label ("Agregar N°Factura" / "Editar N°Factura: <número>")
    const boton = (id, etiqueta) => new RegExp(`<(?:button|a)[^>]*btn-nro-factura[^>]*aria-label="${etiqueta}[^"]*"[^>]*data-id="${id}"`)
    const render = (r, extra = {}) => renderVista(r.vista, { ...r.data, user, scripts: [], ...extra })

    it('el parcial dice "Agregar N°Factura" sin número y "Editar N°Factura" con número', async () => {
      const sin = await renderVista('partials/boton_nro_factura', { op: { id: 5, nro_op: 12, nro_factura: null, facturado: 0, estado: 'pendiente' } })
      assert.match(sin, boton(5, 'Agregar N°Factura'))
      assert.match(sin, /data-nombre="OP-0012"/)
      const con = await renderVista('partials/boton_nro_factura', { op: { id: 5, nro_op: 12, nro_factura: '0001-00000042', facturado: 0, estado: 'pendiente' } })
      assert.match(con, boton(5, 'Editar N°Factura'))
      assert.match(con, /data-nro="0001-00000042"/)
    })

    it('no aparece en una operación facturada ni anulada, ni para quien no carga operaciones', async () => {
      const base = { id: 5, nro_op: 12, nro_factura: 'A-1', estado: 'pendiente' }
      assert.doesNotMatch(await renderVista('partials/boton_nro_factura', { op: { ...base, facturado: 1 } }), /btn-nro-factura/)
      assert.doesNotMatch(await renderVista('partials/boton_nro_factura', { op: { ...base, facturado: 0, estado: 'anulado' } }), /btn-nro-factura/)
      assert.doesNotMatch(await renderVista('partials/boton_nro_factura', { op: { ...base, facturado: 0 }, user: { rol: 'chofer' } }), /btn-nro-factura/)
      assert.match(await renderVista('partials/boton_nro_factura', { op: { ...base, facturado: 0 }, user: { rol: 'admin_ventas' } }), /btn-nro-factura/)
    })

    it('Ventas: cada fila tiene su botón y la página trae el modal y el script', async () => {
      const sinNro = await cantera()
      const conNro = await viaje()
      await guardar(conNro, '0001-00000077')
      const facturada = await cantera()
      await prueba.q(`UPDATE op_encabezado SET facturado = 1, nro_factura = 'A-5' WHERE id = ?`, [facturada])
      const r = await llamar(VentasController, 'index', { user, query: { id_cliente: String(cliente) } })
      assert.equal(r.vista, 'pages/ventas/index', JSON.stringify(r.flashes))
      assert.ok(r.data.scripts.includes('/js/nroFactura.js'))
      const html = await render(r)
      assert.match(html, boton(sinNro, 'Agregar N°Factura'))
      assert.match(html, boton(conNro, 'Editar N°Factura'))
      assert.doesNotMatch(html, new RegExp(`btn-nro-factura[^>]*data-id="${facturada}"`))
      assert.match(html, /id="modal-nro-factura"/)
      assert.ok(revisarIconos(html) >= 3, 'Ver + N°Factura en cada fila')
      assert.match(html, /aria-label="Ver detalle"/)
      assert.doesNotMatch(html, />\s*(Ver|Agregar N°Factura|Marcar como pagada|Marcar pendiente)\s*</)   // ya no hay botones con texto
    })

    it('Alquileres de contenedores: botón en la tabla', async () => {
      const id = await alquiler()
      const r = await llamar(AlquileresController, 'index', { user, query: {} })
      assert.equal(r.vista, 'pages/alquileres/index')
      assert.ok(r.data.scripts.includes('/js/nroFactura.js'))
      const html = await render(r)
      assert.match(html, boton(id, 'Agregar N°Factura'))
      assert.match(html, /id="modal-nro-factura"/)
      assert.ok(revisarIconos(html) >= 4, 'Ver, Editar, Imprimir y N°Factura')
      assert.match(html, /aria-label="Editar alquiler"/)
      assert.match(html, /href="\/remitos\/\d+\/pdf" target="_blank" rel="noopener"/)   // el remito sigue abriendo en otra pestaña
      await guardar(id, '0001-00000088')
      const r2 = await llamar(AlquileresController, 'index', { user, query: {} })
      assert.match(await render(r2), boton(id, 'Editar N°Factura'))
    })

    it('Alquileres de maquinaria: botón en las tablas', async () => {
      const id = await maquinaria()
      const r = await llamar(AlquileresMaquinariaController, 'index', { user, query: {} })
      assert.equal(r.vista, 'pages/alquileres/maquinaria_index')
      assert.ok(r.data.scripts.includes('/js/nroFactura.js'))
      const html = await render(r)
      assert.match(html, boton(id, 'Agregar N°Factura'))
      assert.match(html, /id="modal-nro-factura"/)
      assert.ok(revisarIconos(html) >= 2)
    })
  })

  describe('Cuenta corriente y Liquidaciones', () => {
    const ClientesController = require('../src/controllers/clientes.controller')
    const LiquidacionesController = require('../src/controllers/liquidaciones.controller')
    // El botón es de solo ícono: su nombre es el aria-label ("Agregar N°Factura" / "Editar N°Factura: <número>")
    const boton = (id, etiqueta) => new RegExp(`<(?:button|a)[^>]*btn-nro-factura[^>]*aria-label="${etiqueta}[^"]*"[^>]*data-id="${id}"`)
    const cuantos = (html, id) => (html.match(new RegExp(`btn-nro-factura[^>]*data-id="${id}"`, 'g')) || []).length

    // Tres ventas a cuenta corriente de octubre: una sin número, una con número (y marcada para
    // facturar: tiene un cargo más por el IVA) y una ya facturada
    let cli, sinNro, conNro, facturada
    before(async () => {
      cli = await datos.crearCliente({ cuentaCorriente: true })
      const ventaCC = async (fecha) => {
        const id = (await VentasModel.crear({
          id_cliente: cli, id_administrativo: admin, tipo_op: 'M', modalidad: 'flete', metodo_pago: 'cuenta_corriente',
          fecha_emision: fecha, fecha_entrega_planificada: fecha, domicilio: { calle: 'Colón', altura: '100' }, obra: null,
          precio_flete: 0, monto_total: 1000, detalles: [{ id_producto: producto, cantidad_pedida: 1, precio_unitario: 1000 }],
        })).id
        await VentasModel.sincronizarCargoCC(id)
        return id
      }
      sinNro = await ventaCC('2026-10-05')
      conNro = await ventaCC('2026-10-06')
      await llamar(FacturacionController, 'marcar', { user, params: { id: conNro }, body: { nroFactura: '0001-00000123' } })
      facturada = await ventaCC('2026-10-07')
      await prueba.q(`UPDATE op_encabezado SET facturado = 1, nro_factura = 'A-77' WHERE id = ?`, [facturada])
    })

    it('Cuenta corriente: un botón por operación (aunque tenga varios cargos) y ninguno en la facturada', async () => {
      const r = await llamar(ClientesController, 'cuentaDetalle', { user, params: { id: cli }, query: { desde: '2026-10-01' } })
      assert.equal(r.vista, 'pages/clientes/cuenta_detalle', JSON.stringify(r.flashes))
      assert.ok(r.data.scripts.includes('/js/nroFactura.js'))
      const html = await renderVista(r.vista, { ...r.data, user })
      assert.match(html, boton(sinNro, 'Agregar N°Factura'))
      assert.match(html, boton(conNro, 'Editar N°Factura'))
      assert.match(html, new RegExp(`btn-nro-factura[^>]*data-id="${conNro}"[^>]*data-nro="0001-00000123"`))
      assert.equal(cuantos(html, conNro), 1)
      assert.equal(cuantos(html, facturada), 0)
      assert.match(html, /id="modal-nro-factura"/)
      // quien no carga operaciones no lo ve
      assert.doesNotMatch(await renderVista(r.vista, { ...r.data, user: { rol: 'chofer' } }), /btn-nro-factura/)
      // las acciones de cada movimiento son de solo ícono: marcar pagada (verde) y N°Factura
      assert.ok(revisarIconos(html) >= 3)
      assert.match(html, /aria-label="Marcar como pagada[^"]*"/)
      assert.doesNotMatch(html, />\s*(Marcar como pagada|Marcar pendiente|Anular)[^<]*</)
    })

    it('Liquidaciones: botón en la tarjeta de cada operación y ninguno en la facturada', async () => {
      const r = await llamar(LiquidacionesController, 'index', { user, query: { clienteId: String(cli), desde: '2026-10-01', hasta: '2026-10-31' } })
      assert.equal(r.vista, 'pages/liquidaciones/index', JSON.stringify(r.flashes))
      assert.ok(r.data.scripts.includes('/js/nroFactura.js'))
      const html = await renderVista(r.vista, { ...r.data, user })
      assert.match(html, boton(sinNro, 'Agregar N°Factura'))
      assert.match(html, boton(conNro, 'Editar N°Factura'))
      assert.match(html, new RegExp(`btn-nro-factura[^>]*data-id="${conNro}"[^>]*data-nro="0001-00000123"`))
      assert.equal(cuantos(html, facturada), 0)
      assert.match(html, /id="modal-nro-factura"/)
      // la tarjeta se nombra por remito: el modal también (Cuenta corriente y listados usan OP-0001)
      assert.match(html, new RegExp(`btn-nro-factura[^>]*data-id="${sinNro}"[^>]*data-nombre="Remito \\d+"`))
      assert.ok(revisarIconos(html) >= 4, 'Ver y N°Factura por tarjeta, y Marcar como pagada en el pie')
      assert.match(html, /<div class="acciones-fila">/)
    })

    it('guardar desde ahí funciona igual y se ve en las dos pantallas', async () => {
      await guardar(sinNro, '0001-00000555')
      const cuenta = await llamar(ClientesController, 'cuentaDetalle', { user, params: { id: cli }, query: { desde: '2026-10-01' } })
      assert.match(await renderVista(cuenta.vista, { ...cuenta.data, user }), boton(sinNro, 'Editar N°Factura'))
      const liq = await llamar(LiquidacionesController, 'index', { user, query: { clienteId: String(cli), desde: '2026-10-01', hasta: '2026-10-31' } })
      assert.match(await renderVista(liq.vista, { ...liq.data, user }), boton(sinNro, 'Editar N°Factura'))
    })
  })

  describe('pantallas de edición y detalle', () => {
    const campo = /name="nroFactura"/

    it('editar venta con viaje: el campo viene con el número actual', async () => {
      const id = await viaje()
      await guardar(id, '0001-00000090')
      const r = await llamar(VentasController, 'editarViaje', { user, params: { id } })
      const html = await renderVista(r.vista, { ...r.data, user })
      assert.match(html, campo)
      assert.match(html, /name="nroFactura"[^>]*value="0001-00000090"/)
      assert.doesNotMatch(html, /name="nroFactura"[^>]*disabled/)
    })
    it('editar venta con viaje ya facturada: se ve el número pero no se edita', async () => {
      const id = await viaje()
      await prueba.q(`UPDATE op_encabezado SET facturado = 1, nro_factura = 'A-8' WHERE id = ?`, [id])
      const r = await llamar(VentasController, 'editarViaje', { user, params: { id } })
      const html = await renderVista(r.vista, { ...r.data, user })
      assert.doesNotMatch(html, campo)
      assert.match(html, /value="A-8"[^>]*disabled|disabled[^>]*value="A-8"/)
    })

    it('editar alquiler de contenedor', async () => {
      const id = await alquiler()
      await guardar(id, '0001-00000091')
      const r = await llamar(AlquileresController, 'editar', { user, params: { id } })
      const html = await renderVista(r.vista, { ...r.data, user })
      assert.match(html, /name="nroFactura"[^>]*value="0001-00000091"/)
    })

    it('editar alquiler de maquinaria', async () => {
      const id = await maquinaria()
      await guardar(id, '0001-00000092')
      const r = await llamar(AlquileresMaquinariaController, 'editar', { user, params: { id } })
      const html = await renderVista(r.vista, { ...r.data, user })
      assert.match(html, /name="nroFactura"[^>]*value="0001-00000092"/)
    })

    it('detalle: una operación sin marcar también ofrece cargar el número (y ya no pide uno al marcarla)', async () => {
      const id = await cantera()
      const fact = await FacturacionModel.estadoOp(id)
      const html = await renderVista('partials/facturacion_estado', { opId: id, fact, volver: `/ventas/${id}` })
      assert.match(html, new RegExp(`action="/facturacion/${id}/nro-factura"`))
      assert.match(html, /Marcar para facturar/)
      assert.doesNotMatch(html, /N° de Factura \(opcional\)/)
      await guardar(id, '0001-00000093')
      const html2 = await renderVista('partials/facturacion_estado', { opId: id, fact: await FacturacionModel.estadoOp(id), volver: `/ventas/${id}` })
      assert.match(html2, /name="nroFactura"[^>]*value="0001-00000093"/)
      assert.match(html2, /N° de Factura: <span class="fw-semibold">0001-00000093<\/span>/)
    })

    it('detalle: una facturada no ofrece cambiar el número', async () => {
      const id = await cantera()
      await prueba.q(`UPDATE op_encabezado SET facturado = 1, nro_factura = 'A-3' WHERE id = ?`, [id])
      const html = await renderVista('partials/facturacion_estado', { opId: id, fact: await FacturacionModel.estadoOp(id), volver: `/ventas/${id}` })
      assert.doesNotMatch(html, /nro-factura/)
    })
  })
})
