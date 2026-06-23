'use strict'
const VentasModel = require('../models/ventas.model')
const TransaccionesModel = require('../models/transacciones.model')
const FlotaModel = require('../models/flota.model')
const EmpleadosModel = require('../models/empleados.model')
const AlertasModel = require('../models/alertas.model')
const { resolverPeriodo, etiquetaPeriodo } = require('../utils/periodos')

const DashboardController = {
  index(req, res) {
    try {
      const periodo = resolverPeriodo({ preset: 'mes' })
      const filtros = { fechaDesde: periodo.desde, fechaHasta: periodo.hasta }
      const ventas = VentasModel.resumen(filtros)
      const trans  = TransaccionesModel.resumen(filtros)
      const flota  = FlotaModel.resumenFlota()
      const choferes = EmpleadosModel.listarChoferes({ soloActivos: true }).length
      const alertas = AlertasModel.resumen()
      const topAlertas = AlertasModel.listar({}).slice(0, 8)

      res.render('pages/dashboard', {
        titulo: 'Dashboard',
        periodoLabel: etiquetaPeriodo(periodo),
        ventas, trans, flota, choferes, alertas, topAlertas,
      })
    } catch (err) {
      console.error(err); req.flash('error', 'Error al cargar el dashboard.')
      res.render('pages/dashboard', { titulo: 'Dashboard', periodoLabel: '', ventas: {count:0,total:0}, trans: {total:0,count:0,ventas:0,alquileres:0}, flota: {total:0,porEstado:{}}, choferes: 0, alertas: {total:0,vencido:0,critico:0}, topAlertas: [] })
    }
  },
}

module.exports = DashboardController
