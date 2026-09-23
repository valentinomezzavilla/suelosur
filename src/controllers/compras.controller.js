'use strict'
const { query }        = require('../config/db')
const EgresosModel     = require('../models/egresos.model')
const StockModel       = require('../models/stock.model')
const ProveedoresModel = require('../models/proveedores.model')
const EmpleadosModel   = require('../models/empleados.model')
const PagosEmpleadoModel = require('../models/pagos_empleado.model')
const FlotaModel       = require('../models/flota.model')
const CategoriasEgresoModel = require('../models/categoriasEgreso.model')
const { resolverPeriodo, etiquetaPeriodo } = require('../utils/periodos')

// Datos que necesita el formulario (listas para los campos condicionales)
async function datosForm() {
  return {
    proveedores: await ProveedoresModel.listar(),
    empleados:   await EmpleadosModel.listar(),
    vehiculos:   await FlotaModel.listar({}),
    productos:   await StockModel.listar(),
  }
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

        let desc = (descripcion || '').trim()
        // El costo unitario y de flete que se guardan reflejan el subtotal y flete final
        // ya calculados, por si se editaron manualmente.
        await StockModel.registrarIngreso(id_producto, cant, {
          id_proveedor: id_proveedor || null,
          costo_unitario: subtotalMaterial / cant,
          costo_flete: fleteFinal / cant,
          usuario: req.session.user?.id, observaciones: desc,
        })
        if (!desc) desc = 'Compra de material'

        await EgresosModel.crear({
          fecha: fecha || null, categoria, descripcion: desc, monto: montoNum, metodo_pago: metodo_pago || null,
          fletero: fletero || null, id_proveedor: id_proveedor || null, id_producto: id_producto || null,
          origen: 'manual', id_usuario: req.session.user?.id,
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

      await EgresosModel.crear({
        fecha: fecha || null, categoria, descripcion: (descripcion || '').trim(), monto: montoNum, metodo_pago: metodo_pago || null,
        fletero:      cat.campos.includes('fletero')   ? (fletero || null) : null,
        periodo:      cat.campos.includes('periodo')   ? (periodo || null) : null,
        id_proveedor: cat.campos.includes('proveedor') ? (id_proveedor || null) : null,
        id_producto:  cat.campos.includes('producto')  ? (id_producto || null) : null,
        id_empleado:  cat.campos.includes('empleado')  ? (id_empleado || null) : null,
        id_vehiculo:  cat.campos.includes('vehiculo')  ? (id_vehiculo || null) : null,
        datos_extra: datosExtra,
        origen: 'manual', id_usuario: req.session.user?.id,
      })

      req.flash('success', 'Registrado en el libro de compras / pagos.')
      res.redirect('/compras')
    } catch (err) { console.error(err); req.flash('error', err.message || 'Error al registrar.'); res.redirect('/compras/nueva') }
  },

  async eliminar(req, res) {
    try {
      await EgresosModel.eliminar(req.params.id)
      req.flash('success', 'Registro eliminado.')
    } catch (err) { console.error(err); req.flash('error', 'Error al eliminar.') }
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
