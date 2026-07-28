'use strict'
// Catálogo de zonas logísticas (ABM completo) con tarifa de flete.
const { query, transaction } = require('../config/db')

// Las operaciones guardan el nombre de la zona como texto libre, no el id: al renombrar
// una zona hay que arrastrar el cambio a todas estas columnas para no partir el catálogo.
const COLUMNAS_ZONA = [
  ['clientes', 'zona'],
  ['op_encabezado', 'zona'],
  ['op_detalle_contenedor', 'zona_entrega'],
  ['op_detalle_maquinaria', 'zona_entrega'],
  ['circuito_paradas', 'zona'],
]

const ZonasModel = {

  async listar() {
    return (await query(`SELECT * FROM zonas ORDER BY orden, nombre`)).rows
  },

  async listarActivas() {
    return (await query(`SELECT * FROM zonas WHERE activo = 1 ORDER BY orden, nombre`)).rows
  },

  async obtener(id) {
    return (await query(`SELECT * FROM zonas WHERE id = ?`, [id])).rows[0] || null
  },

  // Cuántos registros usan esta zona (por nombre). Sirve para no borrar zonas con historia.
  async usos(nombre) {
    if (!nombre) return 0
    const sumas = COLUMNAS_ZONA.map(([tabla, col]) => `(SELECT COUNT(*) FROM ${tabla} WHERE ${col} = ?)`)
    const params = COLUMNAS_ZONA.map(() => nombre)
    const r = (await query(`SELECT ${sumas.join(' + ')} AS total`, params)).rows[0]
    return Number(r.total) || 0
  },

  async crear({ nombre, tarifa_flete, orden }) {
    const limpio = String(nombre || '').trim()
    if (!limpio) throw new Error('Indicá un nombre para la zona.')
    const existe = (await query(`SELECT id FROM zonas WHERE LOWER(nombre) = LOWER(?)`, [limpio])).rows[0]
    if (existe) throw new Error(`Ya existe una zona llamada "${limpio}".`)
    const siguiente = Number((await query(`SELECT COALESCE(MAX(orden), 0) + 1 AS n FROM zonas`)).rows[0].n) || 1
    await query(`INSERT INTO zonas (nombre, tarifa_flete, orden) VALUES (?, ?, ?)`,
      [limpio, parseFloat(tarifa_flete) || 0, parseInt(orden) || siguiente])
    return limpio
  },

  async actualizar(id, { nombre, tarifa_flete, orden, activo }) {
    const zona = await this.obtener(id)
    if (!zona) throw new Error('La zona no existe.')
    const limpio = String(nombre || '').trim()
    if (!limpio) throw new Error('Indicá un nombre para la zona.')
    if (limpio.toLowerCase() !== zona.nombre.toLowerCase()) {
      const existe = (await query(`SELECT id FROM zonas WHERE LOWER(nombre) = LOWER(?) AND id <> ?`, [limpio, id])).rows[0]
      if (existe) throw new Error(`Ya existe una zona llamada "${limpio}".`)
    }
    await transaction(async (q) => {
      await q(`UPDATE zonas SET nombre = ?, tarifa_flete = ?, orden = ?, activo = ? WHERE id = ?`,
        [limpio, parseFloat(tarifa_flete) || 0, parseInt(orden) || 0, Number(activo) ? 1 : 0, id])
      if (limpio !== zona.nombre) {
        for (const [tabla, col] of COLUMNAS_ZONA) {
          await q(`UPDATE ${tabla} SET ${col} = ? WHERE ${col} = ?`, [limpio, zona.nombre])
        }
      }
    })
    return limpio
  },

  // Solo se borra una zona sin uso: si tiene operaciones o clientes asociados,
  // el camino es desactivarla (deja de ofrecerse, pero el historial sigue leyéndose).
  async eliminar(id) {
    const zona = await this.obtener(id)
    if (!zona) throw new Error('La zona no existe.')
    const usos = await this.usos(zona.nombre)
    if (usos > 0) {
      throw new Error(`No se puede eliminar "${zona.nombre}": la usan ${usos} registro${usos === 1 ? '' : 's'}. Desactivala para dejar de ofrecerla.`)
    }
    await query(`DELETE FROM zonas WHERE id = ?`, [id])
    return zona.nombre
  },

  // Tarifa de flete de una zona por nombre (0 si no existe)
  async tarifaDe(nombre) {
    if (!nombre) return 0
    const r = (await query(`SELECT tarifa_flete FROM zonas WHERE nombre = ?`, [nombre])).rows[0]
    return r ? Number(r.tarifa_flete) || 0 : 0
  },

  // Operaciones pendientes que requieren un viaje, para planificar por zona.
  // Reúne viajes (ventas con flete), entregas/retiros de contenedor y maquinaria.
  async operacionesPendientes() {
    const viajes = (await query(`
      SELECT op.id, op.nro_op, op.estado, op.hora_planificada, COALESCE(NULLIF(op.zona,''),'Sin zona') AS zona,
             COALESCE(c.nombre,'Particular') AS cliente, c.tel_whatsapp,
             TRIM(COALESCE(op.domicilio_calle,'') || ' ' || COALESCE(op.domicilio_altura::text,'')) AS domicilio,
             'Viaje' AS tipo, '/ventas/' || op.id AS link
      FROM op_encabezado op LEFT JOIN clientes c ON c.id = op.id_cliente
      WHERE op.tipo_op='M' AND op.modalidad='flete' AND op.estado IN ('pendiente','despachado')
    `)).rows
    const contEntrega = (await query(`
      SELECT op.id, op.nro_op, op.estado, op.hora_planificada, COALESCE(NULLIF(oc.zona_entrega,''),'Sin zona') AS zona,
             COALESCE(c.nombre,'Particular') AS cliente, c.tel_whatsapp,
             oc.domicilio_entrega AS domicilio, 'Contenedor (entrega)' AS tipo,
             '/alquileres/contenedores/' || op.id AS link
      FROM op_encabezado op JOIN op_detalle_contenedor oc ON oc.id_orden_pedido = op.id
      LEFT JOIN clientes c ON c.id = op.id_cliente
      WHERE op.tipo_op='C' AND op.estado IN ('pendiente','despachado')
    `)).rows
    const maquinaria = (await query(`
      SELECT op.id, op.nro_op, op.estado, op.hora_planificada, COALESCE(NULLIF(om.zona_entrega,''),'Sin zona') AS zona,
             COALESCE(c.nombre,'Particular') AS cliente, c.tel_whatsapp,
             om.domicilio_entrega AS domicilio, 'Maquinaria' AS tipo,
             '/alquileres/maquinaria/' || op.id AS link
      FROM op_encabezado op JOIN op_detalle_maquinaria om ON om.id_orden_pedido = op.id
      LEFT JOIN clientes c ON c.id = op.id_cliente
      WHERE op.tipo_op='MA' AND op.estado IN ('pendiente','despachado')
    `)).rows
    // Retiros de contenedor con plazo vencido (reusa la lógica del circuito del día)
    const ContenedoresModel = require('./contenedores.model')
    const retiros = (await ContenedoresModel.circuitoDiario()).map(r => ({
      id: r.id, nro_op: r.nro_op, estado: 'pendiente_retiro',
      zona: r.zona_entrega || 'Sin zona', cliente: r.cliente_nombre, tel_whatsapp: r.tel_whatsapp,
      domicilio: r.domicilio_entrega, tipo: 'Contenedor (retiro)', link: '/contenedores/circuito',
    }))
    return [...viajes, ...contEntrega, ...maquinaria, ...retiros]
  },
}

module.exports = ZonasModel
