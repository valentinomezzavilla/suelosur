'use strict'
const crypto = require('crypto')
const { query, transaction } = require('../config/db')

const ConfigMaquinariaModel = {

  async obtenerGlobales() {
    return (await query(`SELECT clave, valor FROM config_maquinaria WHERE id_maquinaria IS NULL ORDER BY clave`)).rows
  },

  async obtenerPorMaquinaria(idMaquinaria) {
    return (await query(`SELECT clave, valor FROM config_maquinaria WHERE id_maquinaria = ? ORDER BY clave`, [idMaquinaria])).rows
  },

  async obtenerValor(clave, idMaquinaria) {
    if (idMaquinaria) {
      const row = (await query(`SELECT valor FROM config_maquinaria WHERE id_maquinaria = ? AND clave = ?`, [idMaquinaria, clave])).rows[0]
      if (row) return row.valor
    }
    const global = (await query(`SELECT valor FROM config_maquinaria WHERE id_maquinaria IS NULL AND clave = ?`, [clave])).rows[0]
    return global ? global.valor : null
  },

  async obtenerDefaults() {
    const rows = await this.obtenerGlobales()
    const cfg = {}
    rows.forEach(r => { cfg[r.clave] = r.valor })
    return {
      precioHora:  Number(cfg.precio_por_hora_default)  || 15000,
      precioDia:   Number(cfg.precio_por_dia_default)   || 80000,
      modoPrecio:  cfg.modo_precio_default || 'hora',
    }
  },

  async precioEfectivo(idMaquinaria) {
    const defaults = await this.obtenerDefaults()
    if (!idMaquinaria) return defaults
    const overrides = await this.obtenerPorMaquinaria(idMaquinaria)
    const cfg = {}
    overrides.forEach(r => { cfg[r.clave] = r.valor })
    return {
      precioHora:  Number(cfg.precio_por_hora)  || defaults.precioHora,
      precioDia:   Number(cfg.precio_por_dia)   || defaults.precioDia,
      modoPrecio:  cfg.modo_precio || defaults.modoPrecio,
    }
  },

  async guardarGlobal(datos) {
    await transaction(async (q) => {
      for (const [clave, valor] of Object.entries(datos)) {
        const result = await q(`UPDATE config_maquinaria SET valor = ? WHERE id_maquinaria IS NULL AND clave = ?`, [String(valor), clave])
        if (result.rowCount === 0) {
          await q(`INSERT INTO config_maquinaria (id, id_maquinaria, clave, valor) VALUES (?, NULL, ?, ?) ON CONFLICT DO NOTHING`, [crypto.randomUUID(), clave, String(valor)])
        }
      }
    })
  },

  async guardarPorMaquinaria(idMaquinaria, datos) {
    await transaction(async (q) => {
      for (const [clave, valor] of Object.entries(datos)) {
        if (!valor && valor !== '0') {
          await q(`DELETE FROM config_maquinaria WHERE id_maquinaria = ? AND clave = ?`, [idMaquinaria, clave])
          continue
        }
        const result = await q(`UPDATE config_maquinaria SET valor = ? WHERE id_maquinaria = ? AND clave = ?`, [String(valor), idMaquinaria, clave])
        if (result.rowCount === 0) {
          await q(`INSERT INTO config_maquinaria (id, id_maquinaria, clave, valor) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`, [crypto.randomUUID(), idMaquinaria, clave, String(valor)])
        }
      }
    })
  },
}

module.exports = ConfigMaquinariaModel
