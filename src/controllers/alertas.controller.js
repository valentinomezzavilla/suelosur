'use strict'
const AlertasModel = require('../models/alertas.model')
const Notif = require('../services/notificaciones.service')
const { generarTablaPDF } = require('../utils/pdfTabla')
const { generarExcel } = require('../utils/excel')

const AlertasController = {

  index(req, res) {
    try {
      const { modulo, tipo, severidad } = req.query
      const alertas = AlertasModel.listar({ modulo, tipo, severidad })
      res.render('pages/alertas/index', {
        titulo: 'Centro de Alertas',
        alertas,
        resumen: AlertasModel.resumen(),
        config: Notif.getConfig(),
        filtros: { modulo: modulo || '', tipo: tipo || '', severidad: severidad || '' },
      })
    } catch (err) { console.error(err); req.flash('error', 'Error al cargar alertas.'); res.redirect('/') }
  },

  guardarConfig(req, res) {
    try {
      Notif.setConfig('email_activo', req.body.email_activo ? '1' : '0')
      Notif.setConfig('email_destinatarios', req.body.email_destinatarios || '')
      Notif.setConfig('umbral_dias', req.body.umbral_dias || '90,60,30')
      Notif.setConfig('alertas_licencias', req.body.alertas_licencias ? '1' : '0')
      Notif.setConfig('alertas_documentos', req.body.alertas_documentos ? '1' : '0')
      Notif.setConfig('alertas_mantenimiento', req.body.alertas_mantenimiento ? '1' : '0')
      req.flash('success', 'Configuración de notificaciones guardada.')
    } catch (err) { console.error(err); req.flash('error', 'Error al guardar.') }
    res.redirect('/alertas')
  },

  exportar(req, res) {
    try {
      const { modulo, tipo, severidad, formato } = req.query
      const alertas = AlertasModel.listar({ modulo, tipo, severidad })
      const columnas = [
        { header: 'Severidad', key: 'severidad' },
        { header: 'Módulo', key: 'modulo' },
        { header: 'Tipo', key: 'titulo', width: 0.28 },
        { header: 'Entidad', key: 'entidad_nombre', width: 0.28 },
        { header: 'Vence', key: 'vence' },
        { header: 'Días', key: 'dias', align: 'right' },
      ]
      const filas = alertas.map(a => ({ ...a, vence: a.fecha || (a.km_restante != null ? a.km_restante + ' km' : '—'), dias: a.dias != null ? a.dias : '—' }))
      if (formato === 'excel') return generarExcel(res, { titulo: 'Centro de alertas', columnas, filas, nombreArchivo: 'alertas' })
      return generarTablaPDF(res, { titulo: 'Centro de alertas', subtitulo: `${filas.length} alertas`, columnas, filas, nombreArchivo: 'alertas' })
    } catch (err) { console.error(err); req.flash('error', 'Error al exportar.'); res.redirect('/alertas') }
  },
}

module.exports = AlertasController
