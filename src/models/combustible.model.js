'use strict'
// Combustible — cargas + consumo/rendimiento por vehículo.
const { query, transaction } = require('../config/db')
const { hoyISO } = require('../utils/fecha')

const CombustibleModel = {

  async listar(id_vehiculo, { desde, hasta } = {}) {
    const wheres = ['c.id_vehiculo = ?']
    const params = [id_vehiculo]
    if (desde) { wheres.push('c.fecha >= ?'); params.push(desde) }
    if (hasta) { wheres.push('c.fecha <= ?'); params.push(hasta) }
    return (await query(`
      SELECT c.*, e.nombre AS chofer_nombre
      FROM combustible c LEFT JOIN empleados e ON e.id = c.id_chofer
      WHERE ${wheres.join(' AND ')}
      ORDER BY c.fecha DESC, c.created_at DESC
    `, params)).rows
  },

  // id_proveedor: estación de servicio (proveedor marcado como tal); la carga suma a la
  // deuda con esa estación (ver estaciones.model.js). `estacion` guarda su nombre a la vista.
  async crear({ id_vehiculo, id_chofer, litros, costo_total, km_al_cargar, estacion, id_proveedor, fecha }) {
    return await transaction(async (q) => {
      if (id_proveedor) {
        const est = (await q(`SELECT nombre FROM proveedores WHERE id = ? AND es_estacion = 1`, [id_proveedor])).rows[0]
        if (!est) throw new Error('La estación de servicio elegida no existe.')
        estacion = est.nombre
      }
      const { rows } = await q(`
        INSERT INTO combustible (id_vehiculo, id_chofer, litros, costo_total, km_al_cargar, estacion, id_proveedor, fecha)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING id
      `, [id_vehiculo, id_chofer || null, parseFloat(litros) || 0, parseFloat(costo_total) || 0,
          parseInt(km_al_cargar) || 0, (estacion || '').trim() || null, id_proveedor || null, fecha || hoyISO()])
      // Actualizar km del vehículo si la carga reporta un km mayor
      const km = parseInt(km_al_cargar) || 0
      if (km) await q(`UPDATE flota_vehiculos SET kilometraje = GREATEST(kilometraje, ?) WHERE id = ?`, [km, id_vehiculo])
      return rows[0].id
    })
  },

  async eliminar(id) {
    await query(`DELETE FROM combustible WHERE id = ?`, [id])
  },

  // Consumo: km recorridos entre cargas / litros. Rendimiento promedio km/l y costo/km.
  async resumen(id_vehiculo, { desde, hasta } = {}) {
    const cargas = (await this.listar(id_vehiculo, { desde, hasta })).slice().reverse() // ascendente por fecha
    let litros = 0, costo = 0
    cargas.forEach(c => { litros += c.litros || 0; costo += c.costo_total || 0 })
    // km recorridos = max km - min km (de las cargas con km > 0)
    const kms = cargas.map(c => c.km_al_cargar).filter(k => k > 0)
    const kmRecorridos = kms.length >= 2 ? Math.max(...kms) - Math.min(...kms) : 0
    const litrosEntre = kms.length >= 2 ? cargas.filter(c => c.km_al_cargar > 0).slice(0, -1).reduce((a, c) => a + (c.litros || 0), 0) : 0
    const rendimiento = litrosEntre > 0 ? kmRecorridos / litrosEntre : 0   // km/l
    const costoPorKm = kmRecorridos > 0 ? costo / kmRecorridos : 0
    return {
      cargas: cargas.length, litros, costo,
      kmRecorridos,
      rendimiento: Math.round(rendimiento * 100) / 100,
      costoPorKm: Math.round(costoPorKm * 100) / 100,
    }
  },
}

module.exports = CombustibleModel
