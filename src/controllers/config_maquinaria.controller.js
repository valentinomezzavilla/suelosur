'use strict'
const ConfigMaquinariaModel = require('../models/config_maquinaria.model')
const MaquinariaModel       = require('../models/maquinaria.model')

const ConfigMaquinariaController = {
  async index(req, res) {
    try {
      const defaults   = await ConfigMaquinariaModel.obtenerDefaults()
      const maquinaria = await MaquinariaModel.listar()
      const overrides  = {}
      await Promise.all(maquinaria.map(async m => {
        overrides[m.id] = await ConfigMaquinariaModel.precioEfectivo(m.id)
      }))
      res.render('pages/maquinaria/configuracion', {
        titulo: 'Configuración — Maquinaria',
        defaults, maquinaria, overrides,
      })
    } catch (err) {
      console.error(err)
      req.flash('error', 'Error al cargar configuración.')
      res.redirect('/maquinaria')
    }
  },

  async guardar(req, res) {
    try {
      const { precio_por_hora_default, precio_por_dia_default, modo_precio_default } = req.body
      await ConfigMaquinariaModel.guardarGlobal({
        precio_por_hora_default: precio_por_hora_default || '15000',
        precio_por_dia_default: precio_por_dia_default || '80000',
        modo_precio_default: modo_precio_default || 'hora',
      })
      req.flash('success', 'Configuración global guardada.')
      res.redirect('/maquinaria/configuracion')
    } catch (err) {
      console.error(err)
      req.flash('error', 'Error al guardar configuración.')
      res.redirect('/maquinaria/configuracion')
    }
  },

  async guardarPorMaquinaria(req, res) {
    try {
      const { idMaquinaria } = req.params
      const { precio_por_hora, precio_por_dia, modo_precio } = req.body
      await ConfigMaquinariaModel.guardarPorMaquinaria(idMaquinaria, {
        precio_por_hora: precio_por_hora || '',
        precio_por_dia: precio_por_dia || '',
        modo_precio: modo_precio || '',
      })
      req.flash('success', 'Precio personalizado guardado.')
      res.redirect('/maquinaria/configuracion')
    } catch (err) {
      console.error(err)
      req.flash('error', 'Error al guardar.')
      res.redirect('/maquinaria/configuracion')
    }
  },
}

module.exports = ConfigMaquinariaController
