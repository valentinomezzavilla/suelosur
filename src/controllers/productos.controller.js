'use strict'
const ProductosModel = require('../models/productos.model')
const paginar        = require('../utils/paginar')
const { normalizarRangos } = require('../utils/contenedor')

// Datos del formulario de producto. Si es contenedor, los rangos de precio por día
// son obligatorios. Devuelve { datos } o { error, datos }.
function leerFormulario(body) {
  const { nombre, unidad_medida, precio_cantera, precio_viaje } = body
  const es_contenedor = body.es_contenedor === '1'
  const datos = { nombre: (nombre || '').trim(), unidad_medida, precio_cantera, precio_viaje, es_contenedor, rangos: [] }
  if (!datos.nombre) return { error: 'El nombre es obligatorio.', datos }
  if (es_contenedor) {
    const { rangos, error } = normalizarRangos(body.rango_hasta, body.rango_precio)
    if (error) return { error, datos: { ...datos, rangos: filasCargadas(body) } }
    datos.rangos = rangos
  }
  return { datos }
}

// Lo que se cargó en la tabla de rangos, tal cual (para volver a mostrarlo si hubo error)
function filasCargadas(body) {
  const lista = (v) => (v == null ? [] : Array.isArray(v) ? v : [v])
  const hs = lista(body.rango_hasta), ps = lista(body.rango_precio)
  return hs.map((h, i) => ({ dias_hasta: h === '' ? null : h, precio_dia: ps[i] ?? '' }))
}

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
        precioDeposito:(p) => Number(p.precio_cantera || 0),
        precioViaje:   (p) => Number(p.precio_viaje || 0),
        stock:         (p) => Number(p.disponible_real || 0),
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
      const { datos, error } = leerFormulario(req.body)
      if (error) {
        // Se re-renderiza (no redirect) para no perder lo que se cargó
        res.locals.error = [error]
        return res.render('pages/productos/form', { titulo: 'Nuevo Producto', producto: datos })
      }
      await ProductosModel.crear(datos)
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
      const { datos, error } = leerFormulario(req.body)
      if (error) {
        res.locals.error = [error]
        return res.render('pages/productos/form', { titulo: 'Editar Producto', producto: { ...datos, id: req.params.id } })
      }
      await ProductosModel.actualizar(req.params.id, datos)
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
