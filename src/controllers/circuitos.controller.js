'use strict'
const CircuitosModel = require('../models/circuitos.model')

const CircuitosController = {

  async index(req, res) {
    try {
      res.render('pages/circuitos/index', { titulo: 'Circuitos Logísticos', circuitos: await CircuitosModel.listar() })
    } catch (err) { console.error(err); req.flash('error', 'Error al cargar circuitos.'); res.redirect('/') }
  },

  async nuevo(req, res) {
    res.render('pages/circuitos/form', {
      titulo: 'Nuevo Circuito', choferes: await CircuitosModel.choferes(), camiones: await CircuitosModel.camiones(),
    })
  },

  async crear(req, res) {
    try {
      const id = await CircuitosModel.crear(req.body)
      req.flash('success', 'Circuito creado. Agregá las paradas.')
      res.redirect(`/circuitos/${id}`)
    } catch (err) { console.error(err); req.flash('error', 'Error al crear el circuito.'); res.redirect('/circuitos/nuevo') }
  },

  async detalle(req, res) {
    try {
      const circuito = await CircuitosModel.obtener(req.params.id)
      if (!circuito) { req.flash('error', 'Circuito no encontrado.'); return res.redirect('/circuitos') }
      res.render('pages/circuitos/detalle', {
        titulo: `Circuito ${require('../utils/fecha').fmtFecha(circuito.fecha)}`,
        circuito, disponibles: await CircuitosModel.operacionesDisponibles(),
      })
    } catch (err) { console.error(err); req.flash('error', 'Error.'); res.redirect('/circuitos') }
  },

  async agregarParada(req, res) {
    try { await CircuitosModel.agregarParada({ id_circuito: req.params.id, id_op_encabezado: req.body.id_op_encabezado }); req.flash('success', 'Parada agregada.') }
    catch (err) { console.error(err); req.flash('error', err.message || 'Error.') }
    res.redirect(`/circuitos/${req.params.id}`)
  },

  async quitarParada(req, res) {
    try { await CircuitosModel.quitarParada(req.params.paradaId) } catch (err) { console.error(err) }
    res.redirect(`/circuitos/${req.params.id}`)
  },

  async estadoParada(req, res) {
    try { await CircuitosModel.estadoParada(req.params.paradaId, req.body.estado) } catch (err) { console.error(err); req.flash('error', err.message || 'Error.') }
    res.redirect(`/circuitos/${req.params.id}`)
  },

  async cambiarEstado(req, res) {
    try { await CircuitosModel.cambiarEstado(req.params.id, req.body.estado); req.flash('success', 'Estado del circuito actualizado.') }
    catch (err) { console.error(err); req.flash('error', err.message || 'Error.') }
    res.redirect(`/circuitos/${req.params.id}`)
  },

  async eliminar(req, res) {
    try { await CircuitosModel.eliminar(req.params.id); req.flash('success', 'Circuito eliminado.') }
    catch (err) { console.error(err); req.flash('error', 'Error.') }
    res.redirect('/circuitos')
  },
}

module.exports = CircuitosController
