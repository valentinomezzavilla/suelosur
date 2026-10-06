'use strict'
const LiquidacionesModel = require('../models/liquidaciones.model')
const ClientesModel = require('../models/clientes.model')
const { normalizarFiltros, nroLiquidacion, TIPOS, ESTADOS } = require('../utils/liquidaciones')
const { generarLiquidacionPDF } = require('../utils/pdfLiquidacion')
const { hoyISO } = require('../utils/fecha')

const LiquidacionesController = {
  async index(req, res) {
    try {
      const filtros = normalizarFiltros(req.query, hoyISO())
      let liquidacion = await LiquidacionesModel.liquidacion(filtros)
      if (liquidacion.clienteInexistente) {
        req.flash('error', 'Cliente no encontrado.')
        filtros.clienteId = null
        filtros.obra = null
        liquidacion = await LiquidacionesModel.liquidacion(filtros)
      }
      const clienteSel = filtros.clienteId ? liquidacion.clientes[0].cliente : null
      const obras = clienteSel ? await ClientesModel.obras(clienteSel.id) : []
      res.render('pages/liquidaciones/index', {
        titulo: 'Liquidaciones', filtros, liquidacion, clienteSel, obras, TIPOS, ESTADOS,
        nro: nroLiquidacion(hoyISO(), filtros.clienteId),
        scripts: ['/js/buscarCliente.js', '/js/filtroObra.js'],
      })
    } catch (err) {
      console.error(err)
      req.flash('error', 'Error al generar la liquidación.')
      res.redirect('/clientes/cuentas')
    }
  },

  async pdf(req, res) {
    try {
      const filtros = normalizarFiltros(req.query, hoyISO())
      const liquidacion = await LiquidacionesModel.liquidacion(filtros)
      if (liquidacion.clienteInexistente) {
        req.flash('error', 'Cliente no encontrado.')
        return res.redirect('/liquidaciones')
      }
      return generarLiquidacionPDF(res, { liquidacion, filtros, general: !filtros.clienteId })
    } catch (err) {
      console.error(err)
      req.flash('error', 'Error al generar la liquidación.')
      res.redirect('/liquidaciones')
    }
  },
}

module.exports = LiquidacionesController
