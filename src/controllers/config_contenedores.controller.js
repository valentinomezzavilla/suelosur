'use strict'
const ConfigContenedoresModel = require('../models/config_contenedores.model')

const ConfigContenedoresController = {
  async index(req, res) {
    try {
      const config = await ConfigContenedoresModel.obtenerTodos()
      const precios = await ConfigContenedoresModel.obtenerPrecios()
      res.render('pages/contenedores/configuracion', {
        titulo: 'Configuración — Contenedores',
        config, precios,
      })
    } catch (err) {
      console.error(err)
      req.flash('error', 'Error al cargar configuración.')
      res.redirect('/contenedores')
    }
  },

  async guardar(req, res) {
    try {
      const { precio_dia, precio_alquiler, plazo_minimo, plazo_maximo, costo_extra_dia, tiempo_entre_alquileres } = req.body
      await ConfigContenedoresModel.guardar({
        precio_dia: precio_dia || '30000',
        precio_alquiler: precio_alquiler || '250000',
        plazo_minimo: plazo_minimo || '4',
        plazo_maximo: plazo_maximo || '9',
        costo_extra_dia: costo_extra_dia || '30000',
        tiempo_entre_alquileres: tiempo_entre_alquileres || '0',
      })
      req.flash('success', 'Configuración guardada.')
      res.redirect('/contenedores/configuracion')
    } catch (err) {
      console.error(err)
      req.flash('error', 'Error al guardar configuración.')
      res.redirect('/contenedores/configuracion')
    }
  },
}

module.exports = ConfigContenedoresController
