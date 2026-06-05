'use strict'
const ProductosModel = require('../models/productos.model')
const paginar        = require('../utils/paginar')

const ProductosController = {
  index(req, res) {
    try {
      const todos = ProductosModel.listar()
      const { items: productos, total, page, limit, totalPaginas } = paginar(todos, req.query.page, 15)
      res.render('pages/productos/index', {
        titulo: 'Productos', productos, total, page, limit, totalPaginas, filtros: req.query,
      })
    } catch (err) {
      console.error(err); req.flash('error', 'Error.'); res.redirect('back')
    }
  },
  nuevo(req, res) {
    res.render('pages/productos/form', { titulo: 'Nuevo Producto', producto: null })
  },
  crear(req, res) {
    try {
      const { nombre, unidad_medida, precio_referencia } = req.body
      if (!nombre) { req.flash('error', 'El nombre es obligatorio.'); return res.redirect('/productos/nuevo') }
      ProductosModel.crear({ nombre, unidad_medida, precio_referencia })
      req.flash('success', 'Producto creado.')
      res.redirect('/productos')
    } catch (err) {
      console.error(err); req.flash('error', 'Error.'); res.redirect('/productos/nuevo')
    }
  },
  editar(req, res) {
    try {
      const producto = ProductosModel.obtener(req.params.id)
      if (!producto) { req.flash('error', 'No encontrado.'); return res.redirect('/productos') }
      res.render('pages/productos/form', { titulo: 'Editar Producto', producto })
    } catch (err) {
      console.error(err); req.flash('error', 'Error.'); res.redirect('/productos')
    }
  },
  actualizar(req, res) {
    try {
      const { nombre, unidad_medida, precio_referencia } = req.body
      if (!nombre) { req.flash('error', 'El nombre es obligatorio.'); return res.redirect(`/productos/${req.params.id}/editar`) }
      ProductosModel.actualizar(req.params.id, { nombre, unidad_medida, precio_referencia })
      req.flash('success', 'Producto actualizado.')
      res.redirect('/productos')
    } catch (err) {
      console.error(err); req.flash('error', 'Error.'); res.redirect('/productos')
    }
  },
  toggleActivo(req, res) {
    try {
      ProductosModel.toggleActivo(req.params.id)
      req.flash('success', 'Estado actualizado.')
    } catch (err) {
      console.error(err); req.flash('error', 'Error.')
    }
    res.redirect('/productos')
  },
}

module.exports = ProductosController
