'use strict'
const { query, transaction } = require('../config/db')
const { hoyISO }       = require('../utils/fecha')
const { leerFechaPago } = require('../utils/fechaPago')
const EgresosModel     = require('../models/egresos.model')
const CombustibleModel = require('../models/combustible.model')
const StockModel       = require('../models/stock.model')
const ProveedoresModel = require('../models/proveedores.model')
const FleterosModel    = require('../models/fleteros.model')
const EstacionesModel  = require('../models/estaciones.model')
const EmpleadosModel   = require('../models/empleados.model')
const PagosEmpleadoModel = require('../models/pagos_empleado.model')
const FlotaModel       = require('../models/flota.model')
const CategoriasEgresoModel = require('../models/categoriasEgreso.model')
const { resolverPeriodo, etiquetaPeriodo } = require('../utils/periodos')
const { registrarAuditoria } = require('../utils/auditoria')

// Datos que necesita el formulario (listas para los campos condicionales)
async function datosForm() {
  return {
    proveedores: await ProveedoresModel.listar(),
    estaciones:  await EstacionesModel.listar(),
    empleados:   await EmpleadosModel.listar(),
    choferes:    await EmpleadosModel.listarChoferes({ soloActivos: true }),
    vehiculos:   await FlotaModel.listar({}),
    productos:   await StockModel.listar(),
  }
}

// Lo que no se corrige desde Compras / Pagos (se corrige donde nació)
function motivoNoEditable(e) {
  if (e.origen === 'tercero') return 'Esta salida es la transferencia de un cliente destinada a un tercero: se corrige desde la transacción del cobro.'
  if (e.categoria === 'sueldo' && e.pago_tipo === 'descuento') return 'Un descuento al empleado no es una salida de dinero: se corrige desde su ficha.'
  return null
}

function datosExtraDe(e) {
  try { return JSON.parse(e.datos_extra || '{}') || {} } catch { return {} }
}

// Lo que pide "Impacta en autonomía del camión" (además del chofer), como texto; null si está todo
function faltantesCarga(d) {
  const faltan = [
    !d.id_vehiculo && 'el camión',
    !d.id_proveedor && 'la estación de servicio',
    !(parseFloat(d.litros) > 0) && 'los litros',
  ].filter(Boolean)
  return faltan.length ? faltan.join(', ').replace(/, ([^,]*)$/, ' y $1') : null
}

// Qué había antes de la corrección (queda en la auditoría; el detalle muestra la última edición)
async function auditarEdicion(id, antes, usuario) {
  const campos = ['fecha', 'categoria', 'descripcion', 'monto', 'metodo_pago', 'id_proveedor', 'id_producto', 'cantidad',
    'subtotal_material', 'costo_final_flete', 'fletero', 'id_empleado', 'id_vehiculo', 'periodo', 'hora', 'nro_factura',
    'nro_remito', 'litros', 'id_chofer', 'id_combustible']
  const resumen = {}
  campos.forEach(c => { if (antes[c] != null && antes[c] !== '') resumen[c] = antes[c] })
  await registrarAuditoria({ entidad_tipo: 'egreso', entidad_id: id, accion: 'editar', usuario, detalle: { antes: resumen } })
}

const ComprasController = {

  async index(req, res) {
    try {
      const { categoria, proveedor, producto, empleado, vehiculo, metodoPago, fletero, descripcion, periodo: periodoSueldo,
              preset, fechaDesde, fechaHasta } = req.query
      const periodo = resolverPeriodo({ preset, desde: fechaDesde, hasta: fechaHasta })
      const filtros = {
        categoria: categoria || null, id_proveedor: proveedor || null, id_producto: producto || null,
        id_empleado: empleado || null, id_vehiculo: vehiculo || null, metodo_pago: metodoPago || null,
        fletero: fletero || null, descripcion: descripcion || null, periodo: periodoSueldo || null,
        fechaDesde: periodo.desde, fechaHasta: periodo.hasta,
      }
      // Recién registrado un sueldo: el banner ofrece el recibo
      const reciboId = /^\d+$/.test(String(req.query.recibo || '')) ? Number(req.query.recibo) : null
      res.render('pages/compras/index', {
        titulo: 'Compras / Pagos',
        reciboId,
        egresos: await EgresosModel.listar(filtros),
        resumen: await EgresosModel.resumen(filtros),
        fleteros: await EgresosModel.fleteros(),
        categorias: await CategoriasEgresoModel.listar(),
        periodoLabel: etiquetaPeriodo(periodo),
        filtros: {
          categoria: categoria || '', proveedor: proveedor || '', producto: producto || '',
          empleado: empleado || '', vehiculo: vehiculo || '', metodoPago: metodoPago || '',
          fletero: fletero || '', descripcion: descripcion || '', periodo: periodoSueldo || '',
          preset: periodo.preset || '', fechaDesde: periodo.desde || '', fechaHasta: periodo.hasta || '',
        },
        ...(await datosForm()),
      })
    } catch (err) { console.error(err); req.flash('error', 'Error al cargar compras / pagos.'); res.redirect('/') }
  },

  async nueva(req, res) {
    res.render('pages/compras/form', {
      titulo: 'Registrar compra / pago',
      categorias: await CategoriasEgresoModel.listar({ soloActivas: true }),
      fleteros: await FleterosModel.listar(),   // sugerencias del campo Fletero
      ...(await datosForm()),
    })
  },

  async crear(req, res) {
    try {
      const { categoria, fecha, monto, metodo_pago, descripcion,
              id_proveedor, id_empleado, id_vehiculo,
              id_producto, cantidad, costo_unitario, costo_flete, fletero,
              subtotal_material, costo_final_flete,
              periodo, descuentos, adiciones } = req.body

      // Fecha de pago: puede ser anterior al día de carga (que queda en created_at), no futura
      const errFecha = fecha ? leerFechaPago(fecha).error : null
      if (errFecha) { req.flash('error', errFecha); return res.redirect('/compras/nueva') }

      const cat = await CategoriasEgresoModel.obtenerPorClave(categoria)
      if (!cat || !cat.activo) { req.flash('error', 'Elegí una categoría válida.'); return res.redirect('/compras/nueva') }

      // Sueldo: el pago queda en el libro de compras / pagos Y en la pestaña de pagos del
      // empleado, con su recibo. `monto` es el sueldo; descuentos y adiciones lo ajustan.
      if (categoria === 'sueldo') {
        if (!id_empleado) { req.flash('error', 'Elegí el empleado al que se le paga el sueldo.'); return res.redirect('/compras/nueva') }
        const pago = await PagosEmpleadoModel.registrar({
          id_empleado, tipo: 'sueldo', periodo: (periodo || '').trim() || null,
          monto, descuentos, adiciones, fecha: fecha || null, descripcion, metodo_pago: metodo_pago || null,
          id_usuario: req.session.user?.id, origen: 'manual',
        })
        req.flash('success', 'Sueldo registrado en Compras / Pagos y en la ficha del empleado.')
        return res.redirect(`/compras?recibo=${pago.id}`)
      }

      // Material: mueve stock, con lógica propia (cantidad, costo unitario, flete).
      if (categoria === 'material') {
        const cant  = parseFloat(cantidad) || 0
        const costo = parseFloat(costo_unitario) || 0
        const flete = parseFloat(costo_flete) || 0
        // Subtotal material (cantidad × costo unitario) y Costo final flete (cantidad ×
        // costo flete) se calculan en el cliente pero se recalculan acá por si no llegan o
        // fueron manipulados; el monto final siempre es la suma de ambos.
        const subtotalMaterial = parseFloat(subtotal_material) || (cant * costo)
        const fleteFinal = parseFloat(costo_final_flete) || (cant * flete)
        const montoNum = subtotalMaterial + fleteFinal

        if (montoNum <= 0) { req.flash('error', 'Ingresá un monto mayor a cero.'); return res.redirect('/compras/nueva') }
        if (!id_producto || cant <= 0) { req.flash('error', 'Para material, elegí el producto y una cantidad válida.'); return res.redirect('/compras/nueva') }

        const obs = (descripcion || '').trim()
        const dia = fecha || hoyISO()   // compra e ingreso de stock con el mismo día
        // Ingreso de stock y compra en una sola transacción: o quedan los dos o ninguno.
        // El costo unitario y de flete que se guardan reflejan el subtotal y flete final
        // ya calculados, por si se editaron manualmente.
        await transaction(async (q) => {
          const idIngreso = await StockModel.registrarIngreso(id_producto, cant, {
            id_proveedor: id_proveedor || null,
            costo_unitario: subtotalMaterial / cant,
            costo_flete: fleteFinal / cant,
            usuario: req.session.user?.id, observaciones: obs, fecha: dia,
          }, q)
          await EgresosModel.crear({
            fecha: dia, categoria, descripcion: obs || 'Compra de material', monto: montoNum, metodo_pago: metodo_pago || null,
            fletero: fletero || null, id_proveedor: id_proveedor || null, id_producto: id_producto || null,
            cantidad: cant, subtotal_material: subtotalMaterial, costo_final_flete: fleteFinal, id_stock_ingreso: idIngreso,
            origen: 'manual', id_usuario: req.session.user?.id,
          }, q)
        })
        req.flash('success', 'Registrado en el libro de compras / pagos.')
        return res.redirect('/compras')
      }

      // Categoría genérica (no del sistema): guarda el egreso con los campos que esa
      // categoría tiene habilitados (ver categorias_egreso.campos) más los campos
      // propios que haya definido (categorias_egreso.campos_custom), que se guardan
      // en egresos.datos_extra por su clave.
      const montoNum = parseFloat(monto) || 0
      if (montoNum <= 0) { req.flash('error', 'Ingresá un monto mayor a cero.'); return res.redirect('/compras/nueva') }

      const datosExtra = {}
      cat.camposCustom.forEach(cf => {
        const v = (req.body[cf.clave] || '').toString().trim()
        if (v) datosExtra[cf.clave] = v
      })

      const egreso = {
        fecha: fecha || null, categoria, descripcion: (descripcion || '').trim(), monto: montoNum, metodo_pago: metodo_pago || null,
        fletero:      cat.campos.includes('fletero')   ? (fletero || null) : null,
        periodo:      cat.campos.includes('periodo')   ? (periodo || null) : null,
        // Estación de servicio también va en id_proveedor (y baja la deuda con la estación)
        id_proveedor: (cat.campos.includes('proveedor') || cat.campos.includes('estacion')) ? (id_proveedor || null) : null,
        id_producto:  cat.campos.includes('producto')  ? (id_producto || null) : null,
        id_empleado:  cat.campos.includes('empleado')  ? (id_empleado || null) : null,
        id_vehiculo:  cat.campos.includes('vehiculo')  ? (id_vehiculo || null) : null,
        datos_extra: datosExtra,
        origen: 'manual', id_usuario: req.session.user?.id,
      }

      // Datos de la carga de combustible (campo 'carga'): quedan en el pago. Con "Impacta en
      // autonomía del camión" el pago crea además la carga en Flota → camión → Combustible:
      // la carga suma a la deuda con la estación y este mismo pago la cancela.
      // El chofer es obligatorio siempre: aunque el pago lo cargue administración, queda
      // registrado quién hizo la carga.
      const conCarga = cat.campos.includes('carga')
      if (conCarga) {
        const { hora, nro_factura, nro_remito, litros, id_chofer } = req.body
        if (!id_chofer) { req.flash('error', 'Elegí el chofer que hizo la carga de combustible.'); return res.redirect('/compras/nueva') }
        Object.assign(egreso, { hora, nro_factura, nro_remito, litros, id_chofer })
      }
      if (conCarga && req.body.impacta_flota === '1') {
        const faltan = faltantesCarga(egreso)
        if (faltan) {
          req.flash('error', `Para que impacte en el camión, completá ${faltan}.`)
          return res.redirect('/compras/nueva')
        }
        egreso.fecha = fecha || hoyISO()   // pago y carga con el mismo día
        await transaction(async (q) => {
          egreso.id_combustible = await CombustibleModel.crear({
            id_vehiculo: egreso.id_vehiculo, id_chofer: egreso.id_chofer, id_proveedor: egreso.id_proveedor,
            litros: egreso.litros, costo_total: montoNum, km_al_cargar: req.body.km_al_cargar,
            fecha: egreso.fecha, hora: egreso.hora, nro_factura: egreso.nro_factura, nro_remito: egreso.nro_remito,
          }, q)
          await EgresosModel.crear(egreso, q)
        })
        req.flash('success', 'Registrado en Compras / Pagos y como carga de combustible del camión.')
        return res.redirect('/compras')
      }

      await EgresosModel.crear(egreso)

      req.flash('success', 'Registrado en el libro de compras / pagos.')
      res.redirect('/compras')
    } catch (err) { console.error(err); req.flash('error', err.message || 'Error al registrar.'); res.redirect('/compras/nueva') }
  },

  // ── Editar compra / pago ─────────────────────────────────────
  // El mismo formulario del alta, con los datos cargados. La categoría no se cambia.
  async editar(req, res) {
    try {
      const egreso = await EgresosModel.obtenerDetalle(req.params.id)
      if (!egreso) { req.flash('error', 'No se encontró la compra / pago.'); return res.redirect('/compras') }
      const bloqueo = motivoNoEditable(egreso)
      if (bloqueo) { req.flash('error', bloqueo); return res.redirect('/compras') }
      res.render('pages/compras/form', {
        titulo: 'Editar compra / pago',
        egreso,
        categorias: await CategoriasEgresoModel.listar(),   // también la inactiva, si es la de este registro
        fleteros: await FleterosModel.listar(),
        ...(await datosForm()),
      })
    } catch (err) { console.error(err); req.flash('error', 'Error al abrir la compra / pago.'); res.redirect('/compras') }
  },

  async actualizar(req, res) {
    const id = req.params.id
    const volver = `/compras/${id}/editar`
    try {
      const e = await EgresosModel.obtenerDetalle(id)
      if (!e) { req.flash('error', 'No se encontró la compra / pago.'); return res.redirect('/compras') }
      const bloqueo = motivoNoEditable(e)
      if (bloqueo) { req.flash('error', bloqueo); return res.redirect('/compras') }
      const b = req.body
      const errFecha = b.fecha ? leerFechaPago(b.fecha).error : null
      if (errFecha) { req.flash('error', errFecha); return res.redirect(volver) }
      const usuario = req.session.user?.id
      const comunes ={ fecha: b.fecha || e.fecha, descripcion: (b.descripcion || '').trim(), metodo_pago: b.metodo_pago || null }

      // Sueldo (o cualquier pago a empleado): se corrige el pago de la ficha y su recibo
      if (e.categoria === 'sueldo' && e.id_pago_empleado) {
        if (!b.id_empleado) { req.flash('error', 'Elegí el empleado.'); return res.redirect(volver) }
        await PagosEmpleadoModel.actualizar(e.id_pago_empleado, {
          ...comunes, id_empleado: b.id_empleado, periodo: (b.periodo || '').trim() || null,
          monto: b.monto, descuentos: b.descuentos, adiciones: b.adiciones,
        })
        await auditarEdicion(id, e, usuario)
        req.flash('success', 'Pago corregido en Compras / Pagos, en la ficha del empleado y en su recibo.')
        return res.redirect('/compras')
      }

      // Material: el monto es subtotal + flete, y la corrección mueve el stock
      if (e.categoria === 'material') {
        const cant = parseFloat(b.cantidad) || 0
        const subtotal = parseFloat(b.subtotal_material) || cant * (parseFloat(b.costo_unitario) || 0)
        const flete = parseFloat(b.costo_final_flete) || cant * (parseFloat(b.costo_flete) || 0)
        const monto = subtotal + flete
        if (monto <= 0) { req.flash('error', 'Ingresá un monto mayor a cero.'); return res.redirect(volver) }
        if (!b.id_producto || cant <= 0) { req.flash('error', 'Elegí el producto y una cantidad válida.'); return res.redirect(volver) }
        const r = await EgresosModel.editar(id, {
          ...comunes, descripcion: comunes.descripcion || 'Compra de material', observaciones: comunes.descripcion, monto,
          fletero: b.fletero || null, id_proveedor: b.id_proveedor || null, id_producto: b.id_producto,
          cantidad: cant, subtotal_material: subtotal, costo_final_flete: flete, datos_extra: datosExtraDe(e),
        })
        await auditarEdicion(id, e, usuario)
        req.flash('success', r.stockMovido
          ? 'Compra corregida: el stock y el ingreso de stock quedaron actualizados.'
          : 'Compra corregida. Es anterior al vínculo con stock: si cambió el producto o la cantidad, ajustá el stock desde Stock.')
        return res.redirect('/compras')
      }

      // Resto de las categorías: los campos que la categoría usa
      // (un sueldo viejo sin pago en la ficha del empleado se corrige como un registro común)
      const cat = e.categoria === 'sueldo'
        ? { campos: ['empleado', 'periodo'], camposCustom: [] }
        : ((await CategoriasEgresoModel.obtenerPorClave(e.categoria)) || { campos: [], camposCustom: [] })
      const usa = (c) => cat.campos.includes(c)
      const monto = parseFloat(b.monto) || 0
      if (monto <= 0) { req.flash('error', 'Ingresá un monto mayor a cero.'); return res.redirect(volver) }
      const extra = datosExtraDe(e)
      cat.camposCustom.forEach(cf => {
        const v = (b[cf.clave] || '').toString().trim()
        if (v) extra[cf.clave] = v; else delete extra[cf.clave]
      })
      const datos = {
        ...comunes, monto, datos_extra: extra,
        fletero:      usa('fletero')  ? (b.fletero || null) : e.fletero,
        periodo:      usa('periodo')  ? (b.periodo || null) : e.periodo,
        id_proveedor: (usa('proveedor') || usa('estacion')) ? (b.id_proveedor || null) : e.id_proveedor,
        id_producto:  usa('producto') ? (b.id_producto || null) : e.id_producto,
        id_empleado:  usa('empleado') ? (b.id_empleado || null) : e.id_empleado,
        id_vehiculo:  usa('vehiculo') ? (b.id_vehiculo || null) : e.id_vehiculo,
        // Datos de la carga: si la categoría ya no los usa, quedan como estaban
        hora: e.hora, nro_factura: e.nro_factura, nro_remito: e.nro_remito, litros: e.litros, id_chofer: e.id_chofer,
      }
      let carga = null
      if (usa('carga')) {
        if (!b.id_chofer) { req.flash('error', 'Elegí el chofer que hizo la carga de combustible.'); return res.redirect(volver) }
        Object.assign(datos, { hora: b.hora, nro_factura: b.nro_factura, nro_remito: b.nro_remito, litros: b.litros, id_chofer: b.id_chofer })
        const impacta = b.impacta_flota === '1'
        if (impacta) {
          const faltan = faltantesCarga(datos)
          if (faltan) { req.flash('error', `Para que impacte en el camión, completá ${faltan}.`); return res.redirect(volver) }
        }
        carga = { impacta, km_al_cargar: b.km_al_cargar }
      }
      await EgresosModel.editar(id, datos, { carga })
      await auditarEdicion(id, e, usuario)
      req.flash('success', carga && (carga.impacta || e.id_combustible)
        ? (carga.impacta ? 'Pago corregido, junto con la carga de combustible del camión.' : 'Pago corregido; se quitó la carga del camión.')
        : 'Compra / pago corregido.')
      res.redirect('/compras')
    } catch (err) { console.error(err); req.flash('error', err.message || 'Error al guardar los cambios.'); res.redirect(volver) }
  },

  // Baja: se deshace todo lo que la operación movió (ver EgresosModel.eliminar)
  async eliminar(req, res) {
    try {
      const r = await EgresosModel.eliminar(req.params.id)
      if (!r) req.flash('error', 'No se encontró el registro.')
      else if (r.material && !r.stockRevertido) {
        req.flash('success', 'Compra eliminada. Era anterior al vínculo con el stock: si hace falta, ajustá el stock desde Stock.')
      } else req.flash('success', r.stockRevertido ? 'Compra eliminada: se descontó del stock lo que había entrado.' : 'Registro eliminado.')
    } catch (err) { console.error(err); req.flash('error', err.message || 'Error al eliminar.') }
    res.redirect('/compras')
  },

  // Registro automático desde la alerta de vencimiento de un gasto de vehículo
  // (seguro, impuesto, etc.): crea el egreso y renueva el vencimiento +1 año.
  async pagarGasto(req, res) {
    const back = req.get('Referer') || '/alertas'
    try {
      const g = (await query(`SELECT * FROM gastos_vehiculo WHERE id = ?`, [req.params.gastoId])).rows[0]
      if (!g) { req.flash('error', 'Gasto no encontrado.'); return res.redirect(back) }
      const cat = g.categoria === 'seguro' ? 'seguro'
                : (['impuesto', 'multa'].includes(g.categoria) ? 'impuesto' : 'otro')
      await EgresosModel.crear({
        categoria: cat,
        descripcion: [g.categoria, g.descripcion].filter(Boolean).join(' — '),
        monto: g.monto, id_vehiculo: g.id_vehiculo, origen: 'alerta', id_usuario: req.session.user?.id,
      })
      // Renovar el vencimiento (+1 año) para que la alerta se limpie
      if (g.vencimiento) {
        const base = new Date(String(g.vencimiento).slice(0, 10) + 'T00:00:00')
        base.setFullYear(base.getFullYear() + 1)
        await query(`UPDATE gastos_vehiculo SET vencimiento = ?, estado = 'pagado' WHERE id = ?`,
          [base.toISOString().slice(0, 10), g.id])
      }
      req.flash('success', 'Pago registrado en Compras / Pagos. Vencimiento renovado a un año.')
    } catch (err) { console.error(err); req.flash('error', 'Error al registrar el pago.') }
    res.redirect(back)
  },
}

module.exports = ComprasController
