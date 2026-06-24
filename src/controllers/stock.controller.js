'use strict'
const StockModel = require('../models/stock.model')
const ProveedoresModel = require('../models/proveedores.model')

const StockController = {
  async index(req, res) {
    try {
      const stock = await StockModel.listar()
      res.render('pages/stock/index', { titulo: 'Stock', stock, proveedores: await ProveedoresModel.listar(), scripts: ['/js/stockAjuste.js'] })
    } catch (err) {
      console.error(err); req.flash('error', 'Error.'); res.redirect('back')
    }
  },
  async ajustar(req, res) {
    try {
      await StockModel.ajustar(req.params.id_producto, {
        cantidad_actual: parseInt(req.body.cantidad_actual) || 0,
        stock_minimo:    parseInt(req.body.stock_minimo)    || 0,
      })
      req.flash('success', 'Stock actualizado.')
    } catch (err) {
      console.error(err); req.flash('error', 'Error.')
    }
    res.redirect('/stock')
  },
  async egresoPage(req, res) {
    try {
      const stock = await StockModel.listar()
      res.render('pages/stock/egreso', { titulo: 'Stock — Egreso', stock, scripts: ['/js/stockAjuste.js'] })
    } catch (err) {
      console.error(err); req.flash('error', 'Error.'); res.redirect('/stock')
    }
  },
  async ingreso(req, res) {
    try {
      const cantidad = parseInt(req.body.cantidad) || 0
      if (cantidad <= 0) { req.flash('error', 'Cantidad debe ser mayor a cero.'); return res.redirect('/stock') }
      const item = await StockModel.obtener(req.params.id_producto)
      await StockModel.registrarIngreso(req.params.id_producto, cantidad, {
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
  async egreso(req, res) {
    try {
      const cantidad = parseInt(req.body.cantidad) || 0
      if (cantidad <= 0) { req.flash('error', 'Cantidad debe ser mayor a cero.'); return res.redirect('/stock/egreso') }
      const item = await StockModel.obtener(req.params.id_producto)
      await StockModel.registrarEgreso(req.params.id_producto, cantidad)
      req.flash('success', `Egreso de ${cantidad} ${item?.unidad_medida || 'u.'} registrado.`)
    } catch (err) {
      console.error(err); req.flash('error', 'Error.')
    }
    res.redirect('/stock/egreso')
  },
}

module.exports = StockController
