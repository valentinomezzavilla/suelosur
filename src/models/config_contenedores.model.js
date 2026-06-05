'use strict'
const crypto = require('crypto')
const db = require('../config/db')

const ConfigContenedoresModel = {

  obtenerTodos() {
    return db.prepare(`SELECT clave, valor, descripcion FROM config_contenedores ORDER BY clave`).all()
  },

  obtenerValor(clave) {
    const row = db.prepare(`SELECT valor FROM config_contenedores WHERE clave = ?`).get(clave)
    return row ? row.valor : null
  },

  obtenerPrecios() {
    const rows = this.obtenerTodos()
    const cfg = {}
    rows.forEach(r => { cfg[r.clave] = r.valor })
    return {
      precioDia:       Number(cfg.precio_dia)       || 30000,
      precioAlquiler:  Number(cfg.precio_alquiler)   || 250000,
      plazoMinimo:     Number(cfg.plazo_minimo)      || 4,
      plazoMaximo:     Number(cfg.plazo_maximo)      || 9,
      costoExtraDia:   Number(cfg.costo_extra_dia)   || 30000,
      tiempoEntreAlq:  Number(cfg.tiempo_entre_alquileres) || 0,
    }
  },

  guardar(datos) {
    const upd = db.prepare(`UPDATE config_contenedores SET valor = ? WHERE clave = ?`)
    const ins = db.prepare(`INSERT OR IGNORE INTO config_contenedores (id, clave, valor) VALUES (?, ?, ?)`)
    db.transaction(() => {
      Object.entries(datos).forEach(([clave, valor]) => {
        const result = upd.run(String(valor), clave)
        if (result.changes === 0) ins.run(crypto.randomUUID(), clave, String(valor))
      })
    })()
  },
}

module.exports = ConfigContenedoresModel
