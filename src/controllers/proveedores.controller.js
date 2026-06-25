'use strict'
const ProveedoresModel = require('../models/proveedores.model')
const paginar = require('../utils/paginar')

const ProveedoresController = {

  async index(req, res) {
    try {
      const { q, page, sort, dir, estado } = req.query
      let todos = await ProveedoresModel.listarTodos({ q })
      if (estado === 'activo')   todos = todos.filter(p => !!p.activo)
      if (estado === 'inactivo') todos = todos.filter(p => !p.activo)
      const sortMap = {
        nombre: (p) => (p.nombre || '').toLowerCase(),
        cuit:   (p) => (p.cuit || ''),
        email:  (p) => (p.email || ''),
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
      const { items: proveedores, total, page: pag, limit, totalPaginas } = paginar(todos, page, 20)
      res.render('pages/proveedores/index', {
        titulo: 'Proveedores', proveedores, total, page: pag, limit, totalPaginas,
        filtros: { q: q||'', estado: estado||'', sort: sortKey, dir: dirNorm },
      })
    } catch (err) { console.error(err); req.flash('error', 'Error.'); res.redirect('/') }
  },

  async nuevo(req, res) {
    res.render('pages/proveedores/form', { titulo: 'Nuevo Proveedor', proveedor: null })
  },

  async crear(req, res) {
    try {
      if (!req.body.nombre) { req.flash('error', 'La razón social es obligatoria.'); return res.redirect('/proveedores/nuevo') }
      await ProveedoresModel.crear(req.body)
      req.flash('success', 'Proveedor creado.')
      res.redirect('/proveedores')
    } catch (err) { console.error(err); req.flash('error', 'Error.'); res.redirect('/proveedores/nuevo') }
  },

  async editar(req, res) {
    const proveedor = await ProveedoresModel.obtener(req.params.id)
    if (!proveedor) { req.flash('error', 'No encontrado.'); return res.redirect('/proveedores') }
    res.render('pages/proveedores/form', { titulo: 'Editar Proveedor', proveedor })
  },

  async actualizar(req, res) {
    try {
      if (!req.body.nombre) { req.flash('error', 'La razón social es obligatoria.'); return res.redirect(`/proveedores/${req.params.id}/editar`) }
      await ProveedoresModel.actualizar(req.params.id, req.body)
      req.flash('success', 'Proveedor actualizado.')
      res.redirect('/proveedores')
    } catch (err) { console.error(err); req.flash('error', 'Error.'); res.redirect('/proveedores') }
  },

  async toggleActivo(req, res) {
    try { await ProveedoresModel.toggleActivo(req.params.id); req.flash('success', 'Estado actualizado.') }
    catch (err) { console.error(err); req.flash('error', 'Error.') }
    res.redirect('/proveedores')
  },

  // API JSON para autocomplete (razón social / CUIT)
  async buscarApi(req, res) {
    try {
      const resultados = await ProveedoresModel.buscarLive(req.query.q || '')
      res.json(resultados.map(p => ({ id: p.id, nombre: p.nombre, cuit: p.cuit })))
    } catch (err) { console.error(err); res.status(500).json({ error: 'Error.' }) }
  },
}

module.exports = ProveedoresController
