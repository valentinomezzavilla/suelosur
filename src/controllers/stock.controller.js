'use strict'
const StockModel = require('../models/stock.model')
const ProveedoresModel = require('../models/proveedores.model')

const StockController = {
  index(req, res) {
    try {
      const stock = StockModel.listar()
      res.render('pages/stock/index', { titulo: 'Stock', stock, proveedores: ProveedoresModel.listar(), scripts: ['/js/stockAjuste.js'] })
    } catch (err) {
      console.error(err); req.flash('error', 'Error.'); res.redirect('back')
    }
  },
  ajustar(req, res) {
    try {
      StockModel.ajustar(req.params.id_producto, {
        cantidad_actual: parseInt(req.body.cantidad_actual) || 0,
        stock_minimo:    parseInt(req.body.stock_minimo)    || 0,
      })
      req.flash('success', 'Stock actualizado.')
    } catch (err) {
      console.error(err); req.flash('error', 'Error.')
    }
    res.redirect('/stock')
  },
  egresoPage(req, res) {
    try {
      const stock = StockModel.listar()
      res.render('pages/stock/egreso', { titulo: 'Stock — Egreso', stock, scripts: ['/js/stockAjuste.js'] })
    } catch (err) {
      console.error(err); req.flash('error', 'Error.'); res.redirect('/stock')
    }
  },
  ingreso(req, res) {
    try {
      const cantidad = parseInt(req.body.cantidad) || 0
      if (cantidad <= 0) { req.flash('error', 'Cantidad debe ser mayor a cero.'); return res.redirect('/stock') }
      const item = StockModel.obtener(req.params.id_producto)
      StockModel.registrarIngreso(req.params.id_producto, cantidad, {
        id_proveedor: req.body.id_proveedor || null,
        costo_unitario: req.body.costo_unitario,
        usuario: req.session.user?.id,
      })
      req.flash('success', `Ingreso de ${cantidad} ${item?.unidad_medida || 'u.'} registrado.`)
    } catch (err) {
      console.error(err); req.flash('error', 'Error.')
    }
    res.redirect('/stock')
  },
  egreso(req, res) {
    try {
      const cantidad = parseInt(req.body.cantidad) || 0
      if (cantidad <= 0) { req.flash('error', 'Cantidad debe ser mayor a cero.'); return res.redirect('/stock/egreso') }
      const item = StockModel.obtener(req.params.id_producto)
      StockModel.registrarEgreso(req.params.id_producto, cantidad)
      req.flash('success', `Egreso de ${cantidad} ${item?.unidad_medida || 'u.'} registrado.`)
    } catch (err) {
      console.error(err); req.flash('error', 'Error.')
    }
    res.redirect('/stock/egreso')
  },
}

module.exports = StockController
