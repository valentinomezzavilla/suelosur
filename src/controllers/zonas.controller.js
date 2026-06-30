'use strict'
const ZonasModel = require('../models/zonas.model')

const ZonasController = {

  // Configuración de tarifas de flete por zona
  async config(req, res) {
    try {
      const zonas = await ZonasModel.listar()
      res.render('pages/zonas/config', { titulo: 'Zonas y tarifas', zonas })
    } catch (err) { console.error(err); req.flash('error', 'Error al cargar las zonas.'); res.redirect('/') }
  },

  async guardarTarifas(req, res) {
    try {
      // req.body.tarifa = { Norte: '35000', Sur: '40000', ... }
      await ZonasModel.guardarTarifas(req.body.tarifa || {})
      req.flash('success', 'Tarifas de zona actualizadas.')
    } catch (err) { console.error(err); req.flash('error', 'Error al guardar las tarifas.') }
    res.redirect('/zonas')
  },

  // Planificador logístico: operaciones pendientes agrupadas por zona
  async planificador(req, res) {
    try {
      const ops = await ZonasModel.operacionesPendientes()
      const zonas = await ZonasModel.listarActivas()
      const orden = {}
      zonas.forEach((z, i) => { orden[z.nombre] = z.orden || (i + 1) })
      // Agrupar por zona
      const porZona = {}
      ops.forEach(o => { (porZona[o.zona] = porZona[o.zona] || []).push(o) })
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
