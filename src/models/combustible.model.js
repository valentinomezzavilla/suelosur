'use strict'
// Combustible — cargas + consumo/rendimiento por vehículo.
const { query, transaction } = require('../config/db')
const { hoyISO } = require('../utils/fecha')

// Hora de la carga como 'HH:MM' (el <input type="time"> manda 'HH:MM' o 'HH:MM:SS'); otra cosa → null
function horaHHMM(v) {
  const m = String(v || '').trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/)
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null
  return `${m[1].padStart(2, '0')}:${m[2]}`
}
const texto = (v) => String(v || '').trim() || null

// id_proveedor: estación de servicio (proveedor marcado como tal); la carga suma a la
// deuda con esa estación (ver estaciones.model.js). `estacion` guarda su nombre a la vista.
// nro_factura / nro_remito: los comprobantes de la estación; hora: cuándo se cargó (HH:MM).
async function insertarCarga(q, { id_vehiculo, id_chofer, litros, costo_total, km_al_cargar, estacion, id_proveedor, fecha, hora, nro_factura, nro_remito }) {
  if (id_proveedor) {
    const est = (await q(`SELECT nombre FROM proveedores WHERE id = ? AND es_estacion = 1`, [id_proveedor])).rows[0]
    if (!est) throw new Error('La estación de servicio elegida no existe.')
    estacion = est.nombre
  }
  const { rows } = await q(`
    INSERT INTO combustible (id_vehiculo, id_chofer, litros, costo_total, km_al_cargar, estacion, id_proveedor, fecha,
                             hora, nro_factura, nro_remito)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING id
  `, [id_vehiculo, id_chofer || null, parseFloat(litros) || 0, parseFloat(costo_total) || 0,
      parseInt(km_al_cargar) || 0, texto(estacion), id_proveedor || null, fecha || hoyISO(),
      horaHHMM(hora), texto(nro_factura), texto(nro_remito)])
  // Actualizar km del vehículo si la carga reporta un km mayor
  const km = parseInt(km_al_cargar) || 0
  if (km) await q(`UPDATE flota_vehiculos SET kilometraje = GREATEST(kilometraje, ?) WHERE id = ?`, [km, id_vehiculo])
  return rows[0].id
}

const CombustibleModel = {

  horaHHMM,
  texto,

  async listar(id_vehiculo, { desde, hasta } = {}) {
    const wheres = ['c.id_vehiculo = ?']
    const params = [id_vehiculo]
    if (desde) { wheres.push('c.fecha >= ?'); params.push(desde) }
    if (hasta) { wheres.push('c.fecha <= ?'); params.push(hasta) }
    // id_egreso: el pago de Compras / Pagos que creó la carga (se elimina desde ahí)
    return (await query(`
      SELECT c.*, e.nombre AS chofer_nombre,
             (SELECT eg.id FROM egresos eg WHERE eg.id_combustible = c.id LIMIT 1) AS id_egreso
      FROM combustible c LEFT JOIN empleados e ON e.id = c.id_chofer
      WHERE ${wheres.join(' AND ')}
      ORDER BY c.fecha DESC, c.hora DESC NULLS LAST, c.created_at DESC
    `, params)).rows
  },

  // `q`: la transacción de quien llama (el pago de Compras / Pagos que crea la carga junto
  // con el egreso); sin ella, la carga va en su propia transacción.
  async crear(datos, q = null) {
    if (q) return insertarCarga(q, datos)
    return await transaction((tq) => insertarCarga(tq, datos))
  },

  // Corrige una carga (la que creó un pago de Compras / Pagos, al editar ese pago). Mismos
  // campos que el alta; el km del camión solo sube (igual que al cargar).
  async actualizar(id, { id_vehiculo, id_chofer, litros, costo_total, km_al_cargar, id_proveedor, fecha, hora, nro_factura, nro_remito }, q) {
    let estacion = null
    if (id_proveedor) {
      const est = (await q(`SELECT nombre FROM proveedores WHERE id = ? AND es_estacion = 1`, [id_proveedor])).rows[0]
      if (!est) throw new Error('La estación de servicio elegida no existe.')
      estacion = est.nombre
    }
    await q(`
      UPDATE combustible SET id_vehiculo = ?, id_chofer = ?, litros = ?, costo_total = ?, km_al_cargar = ?, estacion = ?,
                             id_proveedor = ?, fecha = ?, hora = ?, nro_factura = ?, nro_remito = ?
      WHERE id = ?
    `, [id_vehiculo, id_chofer || null, parseFloat(litros) || 0, parseFloat(costo_total) || 0, parseInt(km_al_cargar) || 0,
        estacion, id_proveedor || null, fecha || hoyISO(), horaHHMM(hora), texto(nro_factura), texto(nro_remito), id])
    const km = parseInt(km_al_cargar) || 0
    if (km) await q(`UPDATE flota_vehiculos SET kilometraje = GREATEST(kilometraje, ?) WHERE id = ?`, [km, id_vehiculo])
  },

  // Una carga creada por un pago de Compras / Pagos se elimina desde ahí, junto con el pago:
  // borrarla sola dejaría el pago bajando la deuda de la estación sin la carga que la sumó.
  async eliminar(id) {
    const pago = (await query(`SELECT id FROM egresos WHERE id_combustible = ? LIMIT 1`, [id])).rows[0]
    if (pago) throw new Error('Esta carga se registró desde Compras / Pagos: eliminá ese pago y se borran los dos.')
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
