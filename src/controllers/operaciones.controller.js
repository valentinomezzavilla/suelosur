'use strict'
const OperacionesModel = require('../models/operaciones.model')

const OperacionesController = {
  asignarRecursos(req, res) {
    try {
      OperacionesModel.asignar(req.params.id, {
        id_chofer: req.body.id_chofer || null,
        id_camion: req.body.id_camion || null,
        usuario: req.session.user?.id,
      })
      req.flash('success', 'Recursos asignados a la operación.')
    } catch (err) {
      console.error(err); req.flash('error', 'Error al asignar recursos.')
    }
    res.redirect(req.get('Referrer') || '/ventas')
  },
}

module.exports = OperacionesController
