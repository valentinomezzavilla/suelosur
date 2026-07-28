'use strict'
const ZonasModel = require('../models/zonas.model')

const ZonasController = {

  // ABM de zonas + tarifa de flete de cada una
  async config(req, res) {
    try {
      const zonas = await ZonasModel.listar()
      // Cuántos registros usa cada zona: las que tienen historia no se pueden eliminar.
      for (const z of zonas) z.usos = await ZonasModel.usos(z.nombre)
      res.render('pages/zonas/config', { titulo: 'Zonas y tarifas', zonas })
    } catch (err) { console.error(err); req.flash('error', 'Error al cargar las zonas.'); res.redirect('/') }
  },

  async crear(req, res) {
    try {
      const nombre = await ZonasModel.crear(req.body)
      req.flash('success', `Zona "${nombre}" creada.`)
    } catch (err) { console.error(err); req.flash('error', err.message || 'Error al crear la zona.') }
    res.redirect('/zonas')
  },

  async actualizar(req, res) {
    try {
      const nombre = await ZonasModel.actualizar(req.params.id, req.body)
      req.flash('success', `Zona "${nombre}" actualizada.`)
    } catch (err) { console.error(err); req.flash('error', err.message || 'Error al actualizar la zona.') }
    res.redirect('/zonas')
  },

  async eliminar(req, res) {
    try {
      const nombre = await ZonasModel.eliminar(req.params.id)
      req.flash('success', `Zona "${nombre}" eliminada.`)
    } catch (err) { console.error(err); req.flash('error', err.message || 'Error al eliminar la zona.') }
    res.redirect('/zonas')
  },

  // Planificador logístico: operaciones pendientes agrupadas por zona
  async planificador(req, res) {
    try {
      const ops = await ZonasModel.operacionesPendientes()
      const zonas = await ZonasModel.listarActivas()
      const orden = {}
      zonas.forEach((z, i) => { orden[z.nombre] = z.orden || (i + 1) })
      // Agrupar por zona (dentro de cada zona, primero las que tienen hora, en orden)
      const porZona = {}
      ops.forEach(o => { (porZona[o.zona] = porZona[o.zona] || []).push(o) })
      Object.values(porZona).forEach(items => items.sort((a, b) =>
        String(a.hora_planificada || '99:99').localeCompare(String(b.hora_planificada || '99:99'))))
      // Ordenar zonas según el catálogo (las "Sin zona" al final)
      const zonasOrdenadas = Object.keys(porZona).sort((a, b) => {
        const oa = orden[a] ?? 999, ob = orden[b] ?? 999
        return oa - ob || a.localeCompare(b)
      })
      res.render('pages/zonas/planificador', {
        titulo: 'Planificador por zona', porZona, zonasOrdenadas, total: ops.length,
      })
    } catch (err) { console.error(err); req.flash('error', 'Error al armar el planificador.'); res.redirect('/') }
  },
}

module.exports = ZonasController
