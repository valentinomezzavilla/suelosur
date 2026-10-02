'use strict'
// Renderiza vistas y parciales EJS con los mismos helpers que pone src/app.js en res.locals.
const path = require('path')
const ejs = require('ejs')
const { icon } = require('../../src/config/icons')
const { fmtFecha, fmtFechaHora, hoyISO } = require('../../src/utils/fecha')
const { sumarDiasHabiles } = require('../../src/utils/diasHabiles')

const VISTAS = path.join(__dirname, '..', '..', 'views')

function renderVista(relativa, locals = {}) {
  return ejs.renderFile(path.join(VISTAS, relativa + '.ejs'), {
    icon, formatFecha: fmtFecha, formatFechaHora: fmtFechaHora, hoyISO, sumarDiasHabiles,
    user: { rol: 'dueno', nombre: 'Prueba' }, success: [], error: [], warning: [],
    ...locals,
  })
}

module.exports = { renderVista }
