'use strict'
const { query } = require('../config/db')
const OperacionesModel = require('../models/operaciones.model')

const OperacionesController = {
  async asignarRecursos(req, res) {
    try {
      const opId = req.params.id
      const { advertencias } = await OperacionesModel.asignar(opId, {
        id_chofer: req.body.id_chofer || null,
        id_camion: req.body.id_camion || null,
        usuario: req.session.user?.id,
      })
      req.flash('success', 'Recursos asignados a la operación.')
      if (advertencias?.length) {
        req.session.solapamiento = { opId: String(opId), advertencias }
      } else {
        delete req.session.solapamiento
      }
    } catch (err) {
      console.error(err); req.flash('error', err.message || 'Error al asignar recursos.')
    }
    res.redirect(req.get('Referrer') || '/ventas')
  },

  async retrasar30(req, res) {
    try {
      const op = (await query(`SELECT hora_planificada FROM op_encabezado WHERE id = ?`, [req.params.id])).rows[0]
      if (!op?.hora_planificada) {
        req.flash('error', 'La operación no tiene hora planificada.')
        return res.redirect(req.get('Referrer') || '/')
      }
      const [h, m] = op.hora_planificada.split(':').map(Number)
      const totalMin = h * 60 + (m || 0) + 30
      const nueva = `${String(Math.floor(totalMin / 60) % 24).padStart(2, '0')}:${String(totalMin % 60).padStart(2, '0')}`
      await query(`UPDATE op_encabezado SET hora_planificada = ? WHERE id = ?`, [nueva, req.params.id])
      delete req.session.solapamiento
      req.flash('success', `Hora actualizada a ${nueva}. Verificá si sigue habiendo solapamiento.`)
    } catch (err) {
      console.error(err); req.flash('error', 'Error al retrasar la operación.')
    }
    res.redirect(req.get('Referrer') || '/')
  },
}

module.exports = OperacionesController
