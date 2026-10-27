'use strict'
const FleterosModel = require('../models/fleteros.model')
const paginar = require('../utils/paginar')

// Datos del formulario (para volver a mostrarlo con lo escrito si algo falla; el error va
// directo a res.locals porque el flash recién se mostraría en el pedido siguiente)
const datosForm = (body) => ({
  nombre: (body.nombre || '').trim(), cuit: body.cuit || '', telefono: body.telefono || '',
  email: body.email || '', domicilio: body.domicilio || '',
})

const FleterosController = {

  async index(req, res) {
    try {
      const { q, page, sort, dir, estado } = req.query
      let todos = await FleterosModel.listarTodos({ q })
      if (estado === 'activo')   todos = todos.filter(f => !!f.activo)
      if (estado === 'inactivo') todos = todos.filter(f => !f.activo)
      const sortMap = {
        nombre:  (f) => (f.nombre || '').toLowerCase(),
        cuit:    (f) => (f.cuit || ''),
        compras: (f) => Number(f.compras) || 0,
        flete:   (f) => Number(f.total_flete) || 0,
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
      const { items: fleteros, total, page: pag, limit, totalPaginas } = paginar(todos, page, 20)
      res.render('pages/fleteros/index', {
        titulo: 'Fleteros', fleteros, total, page: pag, limit, totalPaginas,
        filtros: { q: q||'', estado: estado||'', sort: sortKey, dir: dirNorm },
      })
    } catch (err) { console.error(err); req.flash('error', 'Error.'); res.redirect('/') }
  },

  async nuevo(req, res) {
    res.render('pages/fleteros/form', { titulo: 'Nuevo Fletero', fletero: null, valores: null })
  },

  async crear(req, res) {
    const valores = datosForm(req.body)
    const volver = (msg) => { res.locals.error = [msg]; res.render('pages/fleteros/form', { titulo: 'Nuevo Fletero', fletero: null, valores }) }
    try {
      if (!valores.nombre) return volver('El nombre es obligatorio.')
      if (await FleterosModel.buscarPorNombre(valores.nombre)) return volver(`Ya existe un fletero llamado "${valores.nombre}".`)
      await FleterosModel.crear(valores)
      req.flash('success', 'Fletero creado.')
      res.redirect('/fleteros')
    } catch (err) { console.error(err); req.flash('error', 'Error.'); res.redirect('/fleteros/nuevo') }
  },

  async editar(req, res) {
    const fletero = await FleterosModel.obtener(req.params.id)
    if (!fletero) { req.flash('error', 'No encontrado.'); return res.redirect('/fleteros') }
    res.render('pages/fleteros/form', { titulo: 'Editar Fletero', fletero, valores: null })
  },

  async actualizar(req, res) {
    try {
      const fletero = await FleterosModel.obtener(req.params.id)
      if (!fletero) { req.flash('error', 'No encontrado.'); return res.redirect('/fleteros') }
      const valores = datosForm(req.body)
      const volver = (msg) => { res.locals.error = [msg]; res.render('pages/fleteros/form', { titulo: 'Editar Fletero', fletero, valores }) }
      if (!valores.nombre) return volver('El nombre es obligatorio.')
      if (await FleterosModel.buscarPorNombre(valores.nombre, { exceptoId: fletero.id })) return volver(`Ya existe otro fletero llamado "${valores.nombre}".`)
      await FleterosModel.actualizar(fletero.id, valores)
      req.flash('success', valores.nombre !== fletero.nombre
        ? 'Fletero actualizado. Sus compras / pagos ya figuran con el nombre nuevo.'
        : 'Fletero actualizado.')
      res.redirect('/fleteros')
    } catch (err) { console.error(err); req.flash('error', 'Error.'); res.redirect('/fleteros') }
  },

  async toggleActivo(req, res) {
    try { await FleterosModel.toggleActivo(req.params.id); req.flash('success', 'Estado actualizado.') }
    catch (err) { console.error(err); req.flash('error', 'Error.') }
    res.redirect('/fleteros')
  },
}

module.exports = FleterosController
