'use strict'
const ContenedoresModel = require('../models/contenedores.model')

const ContenedoresController = {

  async index(req, res) {
    try {
      const { estado_paso, estado_general } = req.query
      const contenedores = await ContenedoresModel.listar({ estado_paso, estado_general })
      const resumen      = await ContenedoresModel.resumenPorEstado()
      res.render('pages/contenedores/index', { titulo: 'Contenedores', contenedores, resumen, filtros: req.query })
    } catch (err) {
      console.error(err)
      req.flash('error', 'Error al cargar los contenedores.')
      res.redirect('back')
    }
  },

  async nuevo(req, res) {
    const proximoNumero = await ContenedoresModel.proximoNumero()
    res.render('pages/contenedores/form', { titulo: 'Nuevo Contenedor', contenedor: null, proximoNumero })
  },

  async crear(req, res) {
    try {
      // El número es autoincrementable: lo asigna el modelo, no el usuario.
      const { numero } = await ContenedoresModel.crear({
        estado_general: req.body.estado_general,
        fecha_ultima_pintada: req.body.fecha_ultima_pintada,
        observaciones: req.body.observaciones,
      })
      req.flash('success', `Contenedor N° ${numero} creado.`)
      res.redirect('/contenedores')
    } catch (err) {
      console.error(err)
      req.flash('error', 'Error al crear el contenedor.')
      res.redirect('/contenedores/nuevo')
    }
  },

  async editar(req, res) {
    try {
      const contenedor = await ContenedoresModel.obtener(req.params.id)
      if (!contenedor) { req.flash('error', 'No encontrado.'); return res.redirect('/contenedores') }
      res.render('pages/contenedores/form', { titulo: 'Editar Contenedor', contenedor })
    } catch (err) {
      console.error(err); req.flash('error', 'Error.'); res.redirect('/contenedores')
    }
  },

  async actualizar(req, res) {
    try {
      // El número de contenedor no se modifica (es autoincrementable e inmutable).
      await ContenedoresModel.actualizar(req.params.id, { estado_general: req.body.estado_general, fecha_ultima_pintada: req.body.fecha_ultima_pintada, observaciones: req.body.observaciones })
      req.flash('success', 'Contenedor actualizado.')
      res.redirect('/contenedores')
    } catch (err) {
      console.error(err); req.flash('error', 'Error.'); res.redirect('/contenedores')
    }
  },

  async toggleActivo(req, res) {
    try {
      await ContenedoresModel.toggleActivo(req.params.id)
      req.flash('success', 'Estado actualizado.')
    } catch (err) {
      console.error(err); req.flash('error', 'Error.')
    }
    res.redirect('/contenedores')
  },

  async detalle(req, res) {
    try {
      const contenedor = await ContenedoresModel.obtener(req.params.id)
      if (!contenedor) { req.flash('error', 'No encontrado.'); return res.redirect('/contenedores') }
      const choferes = await ContenedoresModel.choferes()
      const camiones = await ContenedoresModel.camiones()
      res.render('pages/contenedores/detalle', { titulo: `Contenedor N° ${contenedor.numero_contenedor}`, contenedor, choferes, camiones })
    } catch (err) {
      console.error(err); req.flash('error', 'Error.'); res.redirect('/contenedores')
    }
  },

  async registrarMovimiento(req, res) {
    try {
      const { estado_paso, id_chofer, id_camion, observaciones, fecha_movimiento } = req.body
      if (!estado_paso) { req.flash('error', 'Indicá el nuevo estado.'); return res.redirect(`/contenedores/${req.params.id}`) }
      await ContenedoresModel.registrarMovimiento({ id_contenedor: req.params.id, estado_paso, id_chofer: id_chofer || null, id_camion: id_camion || null, observaciones, fecha_movimiento: fecha_movimiento || null })
      req.flash('success', `Movimiento registrado: ${estado_paso.replace('_',' ')}.`)
      res.redirect(`/contenedores/${req.params.id}`)
    } catch (err) {
      console.error(err); req.flash('error', 'Error.'); res.redirect(`/contenedores/${req.params.id}`)
    }
  },

  async circuito(req, res) {
    try {
      const items = await ContenedoresModel.circuitoDiario()
      const porZona = items.reduce((acc, it) => {
        const z = it.zona_entrega || 'Sin zona'
        ;(acc[z] = acc[z] || []).push(it)
        return acc
      }, {})
      res.render('pages/contenedores/circuito', { titulo: 'Circuito del Día', porZona, total: items.length })
    } catch (err) {
      console.error(err); req.flash('error', 'Error.'); res.redirect('/contenedores')
    }
  },
}

module.exports = ContenedoresController
