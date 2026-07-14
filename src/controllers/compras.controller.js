'use strict'
const { query }        = require('../config/db')
const EgresosModel     = require('../models/egresos.model')
const StockModel       = require('../models/stock.model')
const ProveedoresModel = require('../models/proveedores.model')
const EmpleadosModel   = require('../models/empleados.model')
const FlotaModel       = require('../models/flota.model')
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
      const { categoria, proveedor, preset, fechaDesde, fechaHasta } = req.query
      const periodo = resolverPeriodo({ preset, desde: fechaDesde, hasta: fechaHasta })
      const filtros = { categoria: categoria || null, id_proveedor: proveedor || null, fechaDesde: periodo.desde, fechaHasta: periodo.hasta }
      res.render('pages/compras/index', {
        titulo: 'Compras / Pagos',
        egresos: await EgresosModel.listar(filtros),
        resumen: await EgresosModel.resumen(filtros),
        proveedores: await ProveedoresModel.listar(),
        categorias: EgresosModel.CATEGORIAS,
        periodoLabel: etiquetaPeriodo(periodo),
        filtros: { categoria: categoria || '', proveedor: proveedor || '', preset: periodo.preset || '', fechaDesde: periodo.desde || '', fechaHasta: periodo.hasta || '' },
      })
    } catch (err) { console.error(err); req.flash('error', 'Error al cargar compras / pagos.'); res.redirect('/') }
  },

  async nueva(req, res) {
    res.render('pages/compras/form', {
      titulo: 'Registrar compra / pago',
      categorias: EgresosModel.CATEGORIAS,
      ...(await datosForm()),
    })
  },

  async crear(req, res) {
    try {
      const { categoria, fecha, monto, metodo_pago, descripcion,
              id_proveedor, id_empleado, id_vehiculo,
              id_producto, cantidad, costo_unitario } = req.body

      if (!EgresosModel.CATEGORIAS.includes(categoria)) {
        req.flash('error', 'Elegí una categoría válida.'); return res.redirect('/compras/nueva')
      }

      const cant = parseFloat(cantidad) || 0
      const costo = parseFloat(costo_unitario) || 0
      // Monto: el ingresado; para material, si no viene, se calcula cantidad × costo.
      let montoNum = parseFloat(monto) || 0
      if (categoria === 'material' && !montoNum && cant > 0) montoNum = cant * costo

      if (montoNum <= 0) { req.flash('error', 'Ingresá un monto mayor a cero.'); return res.redirect('/compras/nueva') }

      let desc = (descripcion || '').trim()

      // Material: además del egreso, ingresa al stock (como antes).
      if (categoria === 'material') {
        if (!id_producto || cant <= 0) { req.flash('error', 'Para material, elegí el producto y una cantidad válida.'); return res.redirect('/compras/nueva') }
        await StockModel.registrarIngreso(id_producto, cant, {
          id_proveedor: id_proveedor || null, costo_unitario, usuario: req.session.user?.id, observaciones: desc,
        })
        if (!desc) desc = 'Compra de material'
      }

      await EgresosModel.crear({
        fecha: fecha || null, categoria, descripcion: desc, monto: montoNum, metodo_pago: metodo_pago || null,
        id_proveedor: (categoria === 'material' || categoria === 'proveedor') ? (id_proveedor || null) : null,
        id_empleado:  categoria === 'sueldo' ? (id_empleado || null) : null,
        id_vehiculo:  ['seguro', 'mantenimiento', 'combustible', 'impuesto'].includes(categoria) ? (id_vehiculo || null) : null,
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
