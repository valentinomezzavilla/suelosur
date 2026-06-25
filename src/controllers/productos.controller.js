'use strict'
const ProductosModel = require('../models/productos.model')
const paginar        = require('../utils/paginar')

const ProductosController = {
  async index(req, res) {
    try {
      const { q, sort, dir, estado, page } = req.query
      let todos = await ProductosModel.listar()

      // Búsqueda
      if (q && q.trim()) {
        const term = q.trim().toLowerCase()
        todos = todos.filter(p => (p.nombre || '').toLowerCase().includes(term))
      }
      // Filtro por estado
      if (estado === 'activo')   todos = todos.filter(p => !!p.activo)
      if (estado === 'inactivo') todos = todos.filter(p => !p.activo)

      // Sort
      const sortMap = {
        nombre:        (p) => (p.nombre || '').toLowerCase(),
        unidad:        (p) => (p.unidad_medida || '').toLowerCase(),
        precio:        (p) => Number(p.precio_referencia || 0),
      }
      const sortKey = sortMap[sort] ? sort : 'nombre'
      const dirNorm = String(dir || '').toUpperCase() === 'DESC' ? 'DESC' : 'ASC'
      const getter = sortMap[sortKey]
      todos = [...todos].sort((a, b) => {
        const va = getter(a), vb = getter(b)
        if (va < vb) return dirNorm === 'ASC' ? -1 : 1
        if (va > vb) return dirNorm === 'ASC' ?  1 : -1
        return 0
      })

      const { items: productos, total, page: pag, limit, totalPaginas } = paginar(todos, page, 20)
      res.render('pages/productos/index', {
        titulo: 'Productos', productos, total, page: pag, limit, totalPaginas,
        filtros: { q: q||'', estado: estado||'', sort: sortKey, dir: dirNorm },
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
