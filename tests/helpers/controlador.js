'use strict'
// Llama una acción del controlador de alquileres con req/res mínimos.
// Resuelve con { url, flashes } (redirect), { vista, data, flashes } (render) o { json, flashes }.
// Requerirlo DESPUÉS de ./db (el controlador carga los modelos).
const Controller = require('../../src/controllers/alquileres.controller')

function llamar(accion, { body = {}, params = {}, query = {}, user }) {
  return new Promise((resolve, reject) => {
    const flashes = []
    const req = { body, params, query, session: { user }, flash: (tipo, msg) => flashes.push({ tipo, msg }) }
    const res = {
      redirect: (url) => resolve({ url, flashes }),
      render: (vista, data) => resolve({ vista, data, flashes }),
      json: (data) => resolve({ json: data, flashes }),
      status() { return this },
    }
    Promise.resolve(Controller[accion](req, res)).catch(reject)
  })
}

module.exports = { llamar }
