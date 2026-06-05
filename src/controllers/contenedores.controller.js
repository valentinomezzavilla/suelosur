'use strict'
const ContenedoresModel = require('../models/contenedores.model')

const ContenedoresController = {

  index(req, res) {
    try {
      const { estado_paso, estado_general } = req.query
      const contenedores = ContenedoresModel.listar({ estado_paso, estado_general })
      const resumen      = ContenedoresModel.resumenPorEstado()
      res.render('pages/contenedores/index', { titulo: 'Contenedores', contenedores, resumen, filtros: req.query })
    } catch (err) {
      console.error(err)
      req.flash('error', 'Error al cargar los contenedores.')
      res.redirect('back')
    }
  },

  nuevo(req, res) {
    res.render('pages/contenedores/form', { titulo: 'Nuevo Contenedor', contenedor: null })
  },

  crear(req, res) {
    try {
      const numero = parseInt(req.body.numero_contenedor)
      if (!numero || numero <= 0) { req.flash('error', 'El número es obligatorio.'); return res.redirect('/contenedores/nuevo') }
      if (ContenedoresModel.obtenerPorNumero(numero)) { req.flash('error', `Ya existe el contenedor N° ${numero}.`); return res.redirect('/contenedores/nuevo') }
      ContenedoresModel.crear({ numero_contenedor: numero, estado_general: req.body.estado_general, fecha_ultima_pintada: req.body.fecha_ultima_pintada, observaciones: req.body.observaciones })
      req.flash('success', `Contenedor N° ${numero} creado.`)
      res.redirect('/contenedores')
    } catch (err) {
      console.error(err)
      req.flash('error', 'Error al crear el contenedor.')
      res.redirect('/contenedores/nuevo')
    }
  },

  editar(req, res) {
    try {
      const contenedor = ContenedoresModel.obtener(req.params.id)
      if (!contenedor) { req.flash('error', 'No encontrado.'); return res.redirect('/contenedores') }
      res.render('pages/contenedores/form', { titulo: 'Editar Contenedor', contenedor })
    } catch (err) {
      console.error(err); req.flash('error', 'Error.'); res.redirect('/contenedores')
    }
  },

  actualizar(req, res) {
    try {
      const numero = parseInt(req.body.numero_contenedor)
      const existente = ContenedoresModel.obtenerPorNumero(numero)
      if (existente && existente.id !== req.params.id) { req.flash('error', `Ya existe el N° ${numero}.`); return res.redirect(`/contenedores/${req.params.id}/editar`) }
      ContenedoresModel.actualizar(req.params.id, { numero_contenedor: numero, estado_general: req.body.estado_general, fecha_ultima_pintada: req.body.fecha_ultima_pintada, observaciones: req.body.observaciones })
      req.flash('success', 'Contenedor actualizado.')
      res.redirect('/contenedores')
    } catch (err) {
      console.error(err); req.flash('error', 'Error.'); res.redirect('/contenedores')
    }
  },

  toggleActivo(req, res) {
    try {
      ContenedoresModel.toggleActivo(req.params.id)
      req.flash('success', 'Estado actualizado.')
    } catch (err) {
      console.error(err); req.flash('error', 'Error.')
    }
    res.redirect('/contenedores')
  },

  detalle(req, res) {
    try {
      const contenedor = ContenedoresModel.obtener(req.params.id)
      if (!contenedor) { req.flash('error', 'No encontrado.'); return res.redirect('/contenedores') }
      const choferes = ContenedoresModel.choferes()
      const camiones = ContenedoresModel.camiones()
      res.render('pages/contenedores/detalle', { titulo: `Contenedor N° ${contenedor.numero_contenedor}`, contenedor, choferes, camiones })
    } catch (err) {
      console.error(err); req.flash('error', 'Error.'); res.redirect('/contenedores')
    }
  },

  registrarMovimiento(req, res) {
    try {
      const { estado_paso, id_chofer, id_camion, observaciones, fecha_movimiento } = req.body
      if (!estado_paso) { req.flash('error', 'Indicá el nuevo estado.'); return res.redirect(`/contenedores/${req.params.id}`) }
      ContenedoresModel.registrarMovimiento({ id_contenedor: req.params.id, estado_paso, id_chofer: id_chofer || null, id_camion: id_camion || null, observaciones, fecha_movimiento: fecha_movimiento || null })
      req.flash('success', `Movimiento registrado: ${estado_paso.replace('_',' ')}.`)
      res.redirect(`/contenedores/${req.params.id}`)
    } catch (err) {
      console.error(err); req.flash('error', 'Error.'); res.redirect(`/contenedores/${req.params.id}`)
    }
  },

  circuito(req, res) {
    try {
      const items = ContenedoresModel.circuitoDiario()
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
