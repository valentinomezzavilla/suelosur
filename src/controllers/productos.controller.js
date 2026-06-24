'use strict'
const ProductosModel = require('../models/productos.model')
const paginar        = require('../utils/paginar')

const ProductosController = {
  async index(req, res) {
    try {
      const todos = await ProductosModel.listar()
      const { items: productos, total, page, limit, totalPaginas } = paginar(todos, req.query.page, 15)
      res.render('pages/productos/index', {
        titulo: 'Productos', productos, total, page, limit, totalPaginas, filtros: req.query,
      })
    } catch (err) {
      console.error(err); req.flash('error', 'Error.'); res.redirect('back')
    }
  },
  async nuevo(req, res) {
    res.render('pages/productos/form', { titulo: 'Nuevo Producto', producto: null })
  },
  async crear(req, res) {
    try {
      const { nombre, unidad_medida, precio_referencia } = req.body
      if (!nombre) { req.flash('error', 'El nombre es obligatorio.'); return res.redirect('/productos/nuevo') }
      await ProductosModel.crear({ nombre, unidad_medida, precio_referencia })
      req.flash('success', 'Producto creado.')
      res.redirect('/productos')
    } catch (err) {
      console.error(err); req.flash('error', 'Error.'); res.redirect('/productos/nuevo')
    }
  },
  async editar(req, res) {
    try {
      const producto = await ProductosModel.obtener(req.params.id)
      if (!producto) { req.flash('error', 'No encontrado.'); return res.redirect('/productos') }
      res.render('pages/productos/form', { titulo: 'Editar Producto', producto })
    } catch (err) {
      console.error(err); req.flash('error', 'Error.'); res.redirect('/productos')
    }
  },
  async actualizar(req, res) {
    try {
      const { nombre, unidad_medida, precio_referencia } = req.body
      if (!nombre) { req.flash('error', 'El nombre es obligatorio.'); return res.redirect(`/productos/${req.params.id}/editar`) }
      await ProductosModel.actualizar(req.params.id, { nombre, unidad_medida, precio_referencia })
      req.flash('success', 'Producto actualizado.')
      res.redirect('/productos')
    } catch (err) {
      console.error(err); req.flash('error', 'Error.'); res.redirect('/productos')
    }
  },
  async toggleActivo(req, res) {
    try {
      await ProductosModel.toggleActivo(req.params.id)
      req.flash('success', 'Estado actualizado.')
    } catch (err) {
      console.error(err); req.flash('error', 'Error.')
    }
    res.redirect('/productos')
  },
}

module.exports = ProductosController
