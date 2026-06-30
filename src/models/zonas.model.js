'use strict'
// Catálogo de zonas logísticas (Norte/Sur/Este/Oeste/Centro) con tarifa de flete.
const { query, transaction } = require('../config/db')

const ZonasModel = {

  async listar() {
    return (await query(`SELECT * FROM zonas ORDER BY orden, nombre`)).rows
  },

  async listarActivas() {
    return (await query(`SELECT * FROM zonas WHERE activo = 1 ORDER BY orden, nombre`)).rows
  },

  // Tarifa de flete de una zona por nombre (0 si no existe)
  async tarifaDe(nombre) {
    if (!nombre) return 0
    const r = (await query(`SELECT tarifa_flete FROM zonas WHERE nombre = ?`, [nombre])).rows[0]
    return r ? Number(r.tarifa_flete) || 0 : 0
  },

  // Guardar tarifas (recibe { nombreZona: tarifa, ... })
  async guardarTarifas(tarifas) {
    await transaction(async (q) => {
      for (const [nombre, valor] of Object.entries(tarifas || {})) {
        await q(`UPDATE zonas SET tarifa_flete = ? WHERE nombre = ?`, [parseFloat(valor) || 0, nombre])
      }
    })
  },

  // Operaciones pendientes que requieren un viaje, para planificar por zona.
  // Reúne viajes (ventas con flete), entregas/retiros de contenedor y maquinaria.
  async operacionesPendientes() {
    const viajes = (await query(`
      SELECT op.id, op.nro_op, op.estado, COALESCE(NULLIF(op.zona,''),'Sin zona') AS zona,
             COALESCE(c.nombre,'Particular') AS cliente, c.tel_whatsapp,
             TRIM(COALESCE(op.domicilio_calle,'') || ' ' || COALESCE(op.domicilio_altura::text,'')) AS domicilio,
             'Viaje' AS tipo, '/ventas/' || op.id AS link
      FROM op_encabezado op LEFT JOIN clientes c ON c.id = op.id_cliente
      WHERE op.tipo_op='M' AND op.modalidad='flete' AND op.estado IN ('pendiente','despachado')
    `)).rows
    const contEntrega = (await query(`
      SELECT op.id, op.nro_op, op.estado, COALESCE(NULLIF(oc.zona_entrega,''),'Sin zona') AS zona,
             COALESCE(c.nombre,'Particular') AS cliente, c.tel_whatsapp,
             oc.domicilio_entrega AS domicilio, 'Contenedor (entrega)' AS tipo,
             '/alquileres/contenedores/' || op.id AS link
      FROM op_encabezado op JOIN op_detalle_contenedor oc ON oc.id_orden_pedido = op.id
      LEFT JOIN clientes c ON c.id = op.id_cliente
      WHERE op.tipo_op='C' AND op.estado IN ('pendiente','despachado')
    `)).rows
    const maquinaria = (await query(`
      SELECT op.id, op.nro_op, op.estado, COALESCE(NULLIF(om.zona_entrega,''),'Sin zona') AS zona,
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
      id: r.id, nro_op: r.nro_op, estado: 'a_retirar',
      zona: r.zona_entrega || 'Sin zona', cliente: r.cliente_nombre, tel_whatsapp: r.tel_whatsapp,
      domicilio: r.domicilio_entrega, tipo: 'Contenedor (retiro)', link: '/contenedores/circuito',
    }))
    return [...viajes, ...contEntrega, ...maquinaria, ...retiros]
  },
}

module.exports = ZonasModel
