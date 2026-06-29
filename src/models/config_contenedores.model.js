'use strict'
const { query, transaction } = require('../config/db')

const ConfigContenedoresModel = {

  async obtenerTodos() {
    return (await query(`SELECT clave, valor, descripcion FROM config_contenedores ORDER BY clave`)).rows
  },

  async obtenerValor(clave) {
    const row = (await query(`SELECT valor FROM config_contenedores WHERE clave = ?`, [clave])).rows[0]
    return row ? row.valor : null
  },

  async obtenerPrecios() {
    const rows = await this.obtenerTodos()
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

  async guardar(datos) {
    await transaction(async (q) => {
      for (const [clave, valor] of Object.entries(datos)) {
        const result = await q(`UPDATE config_contenedores SET valor = ? WHERE clave = ?`, [String(valor), clave])
        if (result.rowCount === 0) {
          await q(`INSERT INTO config_contenedores (clave, valor) VALUES (?, ?) ON CONFLICT DO NOTHING`, [clave, String(valor)])
        }
      }
    })
  },
}

module.exports = ConfigContenedoresModel
