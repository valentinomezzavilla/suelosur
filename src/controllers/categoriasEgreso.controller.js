'use strict'
const CategoriasEgresoModel = require('../models/categoriasEgreso.model')

// El formulario manda un campo propio por fila (tipo / etiqueta / opciones), las tres
// listas paralelas por índice. Se arman acá como objetos para el modelo.
function leerCamposCustom(body) {
  const tipos     = [].concat(body.campo_custom_tipo || [])
  const etiquetas = [].concat(body.campo_custom_etiqueta || [])
  const opciones  = [].concat(body.campo_custom_opciones || [])
  return etiquetas.map((etiqueta, i) => ({ etiqueta, tipo: tipos[i], opciones: opciones[i] }))
}

const CategoriasEgresoController = {

  async index(req, res) {
    try {
      res.render('pages/compras/categorias/index', {
        titulo: 'Administrar categorías',
        categorias: await CategoriasEgresoModel.listar(),
        camposDisponibles: CategoriasEgresoModel.CAMPOS_DISPONIBLES,
        badgesDisponibles: CategoriasEgresoModel.BADGES_DISPONIBLES,
        tiposCampoDisponibles: CategoriasEgresoModel.TIPOS_CAMPO_DISPONIBLES,
      })
    } catch (err) { console.error(err); req.flash('error', 'Error al cargar las categorías.'); res.redirect('/compras') }
  },

  async nueva(req, res) {
    res.render('pages/compras/categorias/form', {
      titulo: 'Nueva categoría',
      categoria: null,
      camposDisponibles: CategoriasEgresoModel.CAMPOS_DISPONIBLES,
      badgesDisponibles: CategoriasEgresoModel.BADGES_DISPONIBLES,
      tiposCampoDisponibles: CategoriasEgresoModel.TIPOS_CAMPO_DISPONIBLES,
    })
  },

  async crear(req, res) {
    try {
      const campos = [].concat(req.body.campos || [])
      await CategoriasEgresoModel.crear({
        etiqueta: req.body.etiqueta, campos, camposCustom: leerCamposCustom(req.body), badge: req.body.badge,
      })
      req.flash('success', 'Categoría creada.')
      res.redirect('/compras/categorias')
    } catch (err) { console.error(err); req.flash('error', err.message || 'Error al crear la categoría.'); res.redirect('/compras/categorias/nueva') }
  },

  async editar(req, res) {
    const categoria = await CategoriasEgresoModel.obtener(req.params.id)
    if (!categoria) { req.flash('error', 'Categoría no encontrada.'); return res.redirect('/compras/categorias') }
    if (categoria.sistema) { req.flash('error', 'Esta es una categoría del sistema y no se puede editar.'); return res.redirect('/compras/categorias') }
    res.render('pages/compras/categorias/form', {
      titulo: 'Editar categoría',
      categoria,
      camposDisponibles: CategoriasEgresoModel.CAMPOS_DISPONIBLES,
      badgesDisponibles: CategoriasEgresoModel.BADGES_DISPONIBLES,
      tiposCampoDisponibles: CategoriasEgresoModel.TIPOS_CAMPO_DISPONIBLES,
    })
  },

  async actualizar(req, res) {
    try {
      const campos = [].concat(req.body.campos || [])
      await CategoriasEgresoModel.actualizar(req.params.id, {
        etiqueta: req.body.etiqueta, campos, camposCustom: leerCamposCustom(req.body),
        badge: req.body.badge, activo: req.body.activo === 'on',
      })
      req.flash('success', 'Categoría actualizada.')
      res.redirect('/compras/categorias')
    } catch (err) { console.error(err); req.flash('error', err.message || 'Error al actualizar la categoría.'); res.redirect(`/compras/categorias/${req.params.id}/editar`) }
  },

  async toggle(req, res) {
    try { await CategoriasEgresoModel.toggleActivo(req.params.id); req.flash('success', 'Estado actualizado.') }
    catch (err) { console.error(err); req.flash('error', err.message || 'Error al cambiar el estado.') }
    res.redirect('/compras/categorias')
  },

  async eliminar(req, res) {
    try { await CategoriasEgresoModel.eliminar(req.params.id); req.flash('success', 'Categoría eliminada.') }
    catch (err) { console.error(err); req.flash('error', err.message || 'Error al eliminar la categoría.') }
    res.redirect('/compras/categorias')
  },
}

module.exports = CategoriasEgresoController
