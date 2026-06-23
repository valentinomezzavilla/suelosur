'use strict'
const ProveedoresModel = require('../models/proveedores.model')
const paginar = require('../utils/paginar')

const ProveedoresController = {

  index(req, res) {
    try {
      const { q, page } = req.query
      const todos = ProveedoresModel.listarTodos({ q })
      const { items: proveedores, total, page: pag, limit, totalPaginas } = paginar(todos, page, 15)
      res.render('pages/proveedores/index', {
        titulo: 'Proveedores', proveedores, total, page: pag, limit, totalPaginas,
        filtros: { q: q || '' },
      })
    } catch (err) { console.error(err); req.flash('error', 'Error.'); res.redirect('/') }
  },

  nuevo(req, res) {
    res.render('pages/proveedores/form', { titulo: 'Nuevo Proveedor', proveedor: null })
  },

  crear(req, res) {
    try {
      if (!req.body.nombre) { req.flash('error', 'La razón social es obligatoria.'); return res.redirect('/proveedores/nuevo') }
      ProveedoresModel.crear(req.body)
      req.flash('success', 'Proveedor creado.')
      res.redirect('/proveedores')
    } catch (err) { console.error(err); req.flash('error', 'Error.'); res.redirect('/proveedores/nuevo') }
  },

  editar(req, res) {
    const proveedor = ProveedoresModel.obtener(req.params.id)
    if (!proveedor) { req.flash('error', 'No encontrado.'); return res.redirect('/proveedores') }
    res.render('pages/proveedores/form', { titulo: 'Editar Proveedor', proveedor })
  },

  actualizar(req, res) {
    try {
      if (!req.body.nombre) { req.flash('error', 'La razón social es obligatoria.'); return res.redirect(`/proveedores/${req.params.id}/editar`) }
      ProveedoresModel.actualizar(req.params.id, req.body)
      req.flash('success', 'Proveedor actualizado.')
      res.redirect('/proveedores')
    } catch (err) { console.error(err); req.flash('error', 'Error.'); res.redirect('/proveedores') }
  },

  toggleActivo(req, res) {
    try { ProveedoresModel.toggleActivo(req.params.id); req.flash('success', 'Estado actualizado.') }
    catch (err) { console.error(err); req.flash('error', 'Error.') }
    res.redirect('/proveedores')
  },

  // API JSON para autocomplete (razón social / CUIT)
  buscarApi(req, res) {
    try {
      const resultados = ProveedoresModel.buscarLive(req.query.q || '')
      res.json(resultados.map(p => ({ id: p.id, nombre: p.nombre, cuit: p.cuit })))
    } catch (err) { console.error(err); res.status(500).json({ error: 'Error.' }) }
  },
}

module.exports = ProveedoresController
