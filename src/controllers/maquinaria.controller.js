'use strict'
const MaquinariaModel = require('../models/maquinaria.model')

const MaquinariaController = {

  index(req, res) {
    try {
      const { estado_paso, estado_general } = req.query
      const maquinas = MaquinariaModel.listar({ estado_paso, estado_general })
      const resumen  = MaquinariaModel.resumenPorEstado()
      res.render('pages/maquinaria/index', { titulo: 'Maquinaria', maquinas, resumen, filtros: req.query })
    } catch (err) {
      console.error(err); req.flash('error', 'Error.'); res.redirect('back')
    }
  },

  nuevo(req, res) {
    res.render('pages/maquinaria/form', { titulo: 'Nueva Maquinaria', maquina: null })
  },

  crear(req, res) {
    try {
      const { nombre, tipo, patente, modelo, anio, estado_general, km_actuales, observaciones } = req.body
      if (!nombre) { req.flash('error', 'El nombre es obligatorio.'); return res.redirect('/maquinaria/nuevo') }
      MaquinariaModel.crear({ nombre, tipo, patente, modelo, anio, estado_general, km_actuales, observaciones })
      req.flash('success', `Maquinaria "${nombre}" creada.`)
      res.redirect('/maquinaria')
    } catch (err) {
      console.error(err); req.flash('error', 'Error.'); res.redirect('/maquinaria/nuevo')
    }
  },

  editar(req, res) {
    try {
      const maquina = MaquinariaModel.obtener(req.params.id)
      if (!maquina) { req.flash('error', 'No encontrada.'); return res.redirect('/maquinaria') }
      res.render('pages/maquinaria/form', { titulo: 'Editar Maquinaria', maquina })
    } catch (err) {
      console.error(err); req.flash('error', 'Error.'); res.redirect('/maquinaria')
    }
  },

  actualizar(req, res) {
    try {
      MaquinariaModel.actualizar(req.params.id, req.body)
      req.flash('success', 'Maquinaria actualizada.')
      res.redirect('/maquinaria')
    } catch (err) {
      console.error(err); req.flash('error', 'Error.'); res.redirect('/maquinaria')
    }
  },

  toggleActivo(req, res) {
    try {
      MaquinariaModel.toggleActivo(req.params.id)
      req.flash('success', 'Estado actualizado.')
    } catch (err) {
      console.error(err); req.flash('error', 'Error.')
    }
    res.redirect('/maquinaria')
  },

  detalle(req, res) {
    try {
      const maquina = MaquinariaModel.obtener(req.params.id)
      if (!maquina) { req.flash('error', 'No encontrada.'); return res.redirect('/maquinaria') }
      const operarios = MaquinariaModel.operarios()
      const camiones  = MaquinariaModel.camiones()
      res.render('pages/maquinaria/detalle', { titulo: maquina.nombre, maquina, operarios, camiones })
    } catch (err) {
      console.error(err); req.flash('error', 'Error.'); res.redirect('/maquinaria')
    }
  },

  registrarMovimiento(req, res) {
    try {
      const { estado_paso, id_operario, id_camion, observaciones, fecha_movimiento, horas_trabajadas, km_registrados } = req.body
      if (!estado_paso) { req.flash('error', 'Indicá el nuevo estado.'); return res.redirect(`/maquinaria/${req.params.id}`) }
      MaquinariaModel.registrarMovimiento({ id_maquinaria: req.params.id, estado_paso, id_operario: id_operario || null, id_camion: id_camion || null, observaciones, fecha_movimiento: fecha_movimiento || null, horas_trabajadas, km_registrados })
      req.flash('success', `Movimiento registrado: ${estado_paso.replace('_',' ')}.`)
      res.redirect(`/maquinaria/${req.params.id}`)
    } catch (err) {
      console.error(err); req.flash('error', 'Error.'); res.redirect(`/maquinaria/${req.params.id}`)
    }
  },

  registrarMantenimiento(req, res) {
    try {
      MaquinariaModel.registrarMantenimiento({ id_maquinaria: req.params.id, ...req.body })
      req.flash('success', 'Mantenimiento registrado.')
      res.redirect(`/maquinaria/${req.params.id}`)
    } catch (err) {
      console.error(err); req.flash('error', 'Error.'); res.redirect(`/maquinaria/${req.params.id}`)
    }
  },
}

module.exports = MaquinariaController
