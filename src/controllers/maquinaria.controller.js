'use strict'
const MaquinariaModel = require('../models/maquinaria.model')

const MaquinariaController = {

  async index(req, res) {
    try {
      const { estado_paso, estado_general } = req.query
      const maquinas = await MaquinariaModel.listar({ estado_paso, estado_general })
      const resumen  = await MaquinariaModel.resumenPorEstado()
      res.render('pages/maquinaria/index', { titulo: 'Maquinaria', maquinas, resumen, filtros: req.query })
    } catch (err) {
      console.error(err); req.flash('error', 'Error.'); res.redirect('back')
    }
  },

  async nuevo(req, res) {
    res.render('pages/maquinaria/form', { titulo: 'Nueva Maquinaria', maquina: null, estadosOp: MaquinariaModel.ESTADOS_OP })
  },

  async crear(req, res) {
    try {
      if (!req.body.nombre) { req.flash('error', 'El nombre es obligatorio.'); return res.redirect('/maquinaria/nuevo') }
      await MaquinariaModel.crear(req.body)
      req.flash('success', `Maquinaria "${req.body.nombre}" creada.`)
      res.redirect('/maquinaria')
    } catch (err) {
      console.error(err); req.flash('error', err.message || 'Error.'); res.redirect('/maquinaria/nuevo')
    }
  },

  async editar(req, res) {
    try {
      const maquina = await MaquinariaModel.obtener(req.params.id)
      if (!maquina) { req.flash('error', 'No encontrada.'); return res.redirect('/maquinaria') }
      res.render('pages/maquinaria/form', { titulo: 'Editar Maquinaria', maquina, estadosOp: MaquinariaModel.ESTADOS_OP })
    } catch (err) {
      console.error(err); req.flash('error', 'Error.'); res.redirect('/maquinaria')
    }
  },

  async actualizar(req, res) {
    try {
      await MaquinariaModel.actualizar(req.params.id, req.body)
      req.flash('success', 'Maquinaria actualizada.')
      res.redirect(`/maquinaria/${req.params.id}`)
    } catch (err) {
      console.error(err); req.flash('error', err.message || 'Error.'); res.redirect(`/maquinaria/${req.params.id}/editar`)
    }
  },

  async toggleActivo(req, res) {
    try {
      await MaquinariaModel.toggleActivo(req.params.id)
      req.flash('success', 'Estado actualizado.')
    } catch (err) {
      console.error(err); req.flash('error', 'Error.')
    }
    res.redirect('/maquinaria')
  },

  async detalle(req, res) {
    try {
      const maquina = await MaquinariaModel.obtener(req.params.id)
      if (!maquina) { req.flash('error', 'No encontrada.'); return res.redirect('/maquinaria') }
      const operarios = await MaquinariaModel.operarios()
      const camiones  = await MaquinariaModel.camiones()
      res.render('pages/maquinaria/detalle', { titulo: maquina.nombre, maquina, operarios, camiones })
    } catch (err) {
      console.error(err); req.flash('error', 'Error.'); res.redirect('/maquinaria')
    }
  },

  async registrarMovimiento(req, res) {
    try {
      const { estado_paso, id_operario, id_camion, observaciones, fecha_movimiento, horas_trabajadas, km_registrados } = req.body
      if (!estado_paso) { req.flash('error', 'Indicá el nuevo estado.'); return res.redirect(`/maquinaria/${req.params.id}`) }
      await MaquinariaModel.registrarMovimiento({ id_maquinaria: req.params.id, estado_paso, id_operario: id_operario || null, id_camion: id_camion || null, observaciones, fecha_movimiento: fecha_movimiento || null, horas_trabajadas, km_registrados })
      req.flash('success', `Movimiento registrado: ${estado_paso.replace('_',' ')}.`)
      res.redirect(`/maquinaria/${req.params.id}`)
    } catch (err) {
      console.error(err); req.flash('error', 'Error.'); res.redirect(`/maquinaria/${req.params.id}`)
    }
  },

  async registrarMantenimiento(req, res) {
    try {
      await MaquinariaModel.registrarMantenimiento({ id_maquinaria: req.params.id, ...req.body })
      req.flash('success', 'Mantenimiento registrado.')
      res.redirect(`/maquinaria/${req.params.id}`)
    } catch (err) {
      console.error(err); req.flash('error', 'Error.'); res.redirect(`/maquinaria/${req.params.id}`)
    }
  },
}

module.exports = MaquinariaController
