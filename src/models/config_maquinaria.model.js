'use strict'
const crypto = require('crypto')
const db = require('../config/db')

const ConfigMaquinariaModel = {

  obtenerGlobales() {
    return db.prepare(`SELECT clave, valor FROM config_maquinaria WHERE id_maquinaria IS NULL ORDER BY clave`).all()
  },

  obtenerPorMaquinaria(idMaquinaria) {
    return db.prepare(`SELECT clave, valor FROM config_maquinaria WHERE id_maquinaria = ? ORDER BY clave`).all(idMaquinaria)
  },

  obtenerValor(clave, idMaquinaria) {
    if (idMaquinaria) {
      const row = db.prepare(`SELECT valor FROM config_maquinaria WHERE id_maquinaria = ? AND clave = ?`).get(idMaquinaria, clave)
      if (row) return row.valor
    }
    const global = db.prepare(`SELECT valor FROM config_maquinaria WHERE id_maquinaria IS NULL AND clave = ?`).get(clave)
    return global ? global.valor : null
  },

  obtenerDefaults() {
    const rows = this.obtenerGlobales()
    const cfg = {}
    rows.forEach(r => { cfg[r.clave] = r.valor })
    return {
      precioHora:  Number(cfg.precio_por_hora_default)  || 15000,
      precioDia:   Number(cfg.precio_por_dia_default)   || 80000,
      modoPrecio:  cfg.modo_precio_default || 'hora',
    }
  },

  precioEfectivo(idMaquinaria) {
    const defaults = this.obtenerDefaults()
    if (!idMaquinaria) return defaults
    const overrides = this.obtenerPorMaquinaria(idMaquinaria)
    const cfg = {}
    overrides.forEach(r => { cfg[r.clave] = r.valor })
    return {
      precioHora:  Number(cfg.precio_por_hora)  || defaults.precioHora,
      precioDia:   Number(cfg.precio_por_dia)   || defaults.precioDia,
      modoPrecio:  cfg.modo_precio || defaults.modoPrecio,
    }
  },

  guardarGlobal(datos) {
    const upd = db.prepare(`UPDATE config_maquinaria SET valor = ? WHERE id_maquinaria IS NULL AND clave = ?`)
    const ins = db.prepare(`INSERT OR IGNORE INTO config_maquinaria (id, id_maquinaria, clave, valor) VALUES (?, NULL, ?, ?)`)
    db.transaction(() => {
      Object.entries(datos).forEach(([clave, valor]) => {
        const result = upd.run(String(valor), clave)
        if (result.changes === 0) ins.run(crypto.randomUUID(), clave, String(valor))
      })
    })()
  },

  guardarPorMaquinaria(idMaquinaria, datos) {
    const upd = db.prepare(`UPDATE config_maquinaria SET valor = ? WHERE id_maquinaria = ? AND clave = ?`)
    const ins = db.prepare(`INSERT OR IGNORE INTO config_maquinaria (id, id_maquinaria, clave, valor) VALUES (?, ?, ?, ?)`)
    db.transaction(() => {
      Object.entries(datos).forEach(([clave, valor]) => {
        if (!valor && valor !== '0') {
          db.prepare(`DELETE FROM config_maquinaria WHERE id_maquinaria = ? AND clave = ?`).run(idMaquinaria, clave)
          return
        }
        const result = upd.run(String(valor), idMaquinaria, clave)
        if (result.changes === 0) ins.run(crypto.randomUUID(), idMaquinaria, clave, String(valor))
      })
    })()
  },
}

module.exports = ConfigMaquinariaModel
