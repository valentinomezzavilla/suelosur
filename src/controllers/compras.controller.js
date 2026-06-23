'use strict'
const ComprasModel = require('../models/compras.model')
const StockModel = require('../models/stock.model')
const ProveedoresModel = require('../models/proveedores.model')
const { resolverPeriodo, etiquetaPeriodo } = require('../utils/periodos')

const ComprasController = {

  index(req, res) {
    try {
      const { proveedor, producto, preset, fechaDesde, fechaHasta } = req.query
      const periodo = resolverPeriodo({ preset, desde: fechaDesde, hasta: fechaHasta })
      const filtrosBase = { proveedor, producto, fechaDesde: periodo.desde, fechaHasta: periodo.hasta }
      res.render('pages/compras/index', {
        titulo: 'Compras',
        compras: ComprasModel.listar(filtrosBase),
        resumen: ComprasModel.resumen(filtrosBase),
        proveedores: ProveedoresModel.listar(),
        productos: StockModel.listar(),
        periodoLabel: etiquetaPeriodo(periodo),
        filtros: { proveedor: proveedor || '', producto: producto || '', preset: periodo.preset || '', fechaDesde: periodo.desde || '', fechaHasta: periodo.hasta || '' },
      })
    } catch (err) { console.error(err); req.flash('error', 'Error al cargar compras.'); res.redirect('/') }
  },

  nueva(req, res) {
    res.render('pages/compras/form', {
      titulo: 'Registrar Compra',
      proveedores: ProveedoresModel.listar(),
      productos: StockModel.listar(),
    })
  },

  crear(req, res) {
    try {
      const { id_producto, cantidad, id_proveedor, costo_unitario, observaciones } = req.body
      const cant = parseFloat(cantidad) || 0
      if (!id_producto || cant <= 0) { req.flash('error', 'Producto y cantidad válida son obligatorios.'); return res.redirect('/compras/nueva') }
      StockModel.registrarIngreso(id_producto, cant, {
        id_proveedor: id_proveedor || null, costo_unitario, usuario: req.session.user?.id, observaciones,
      })
      req.flash('success', 'Compra registrada e ingresada al stock.')
      res.redirect('/compras')
    } catch (err) { console.error(err); req.flash('error', 'Error al registrar la compra.'); res.redirect('/compras/nueva') }
  },
}

module.exports = ComprasController
