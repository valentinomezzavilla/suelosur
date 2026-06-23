'use strict'
// Circuitos logísticos — agrupan paradas (operaciones) para un chofer + camión en una fecha.
const crypto = require('crypto')
const db = require('../config/db')

const TIPO_PARADA = { M: 'entrega_material', C: 'entrega_contenedor', MA: 'entrega_maquinaria' }

const CircuitosModel = {

  listar() {
    return db.prepare(`
      SELECT c.*,
             (e.nombre || ' ' || COALESCE(e.apellido,'')) AS chofer_nombre,
             v.nombre AS camion_nombre, v.patente AS camion_patente,
             (SELECT COUNT(*) FROM circuito_paradas p WHERE p.id_circuito = c.id) AS paradas,
             (SELECT COUNT(*) FROM circuito_paradas p WHERE p.id_circuito = c.id AND p.estado='completada') AS completadas
      FROM circuitos c
      LEFT JOIN empleados e ON e.id = c.id_empleado
      LEFT JOIN flota_vehiculos v ON v.id = c.id_camion
      ORDER BY c.fecha DESC, c.created_at DESC
    `).all()
  },

  obtener(id) {
    const c = db.prepare(`
      SELECT c.*, (e.nombre || ' ' || COALESCE(e.apellido,'')) AS chofer_nombre,
             v.nombre AS camion_nombre, v.patente AS camion_patente
      FROM circuitos c
      LEFT JOIN empleados e ON e.id = c.id_empleado
      LEFT JOIN flota_vehiculos v ON v.id = c.id_camion
      WHERE c.id = ?
    `).get(id)
    if (!c) return null
    c.paradas = db.prepare(`
      SELECT p.*, op.nro_op, op.tipo_op, op.estado AS op_estado,
             COALESCE(cli.nombre,'Particular') AS cliente_nombre
      FROM circuito_paradas p
      JOIN op_encabezado op ON op.id = p.id_op_encabezado
      LEFT JOIN clientes cli ON cli.id = op.id_cliente
      WHERE p.id_circuito = ? ORDER BY p.orden, p.created_at
    `).all(id)
    return c
  },

  crear({ fecha, id_empleado, id_camion, observaciones }) {
    const id = crypto.randomUUID()
    db.prepare(`INSERT INTO circuitos (id, fecha, id_empleado, id_camion, estado, observaciones) VALUES (?, ?, ?, ?, 'borrador', ?)`)
      .run(id, fecha || new Date().toISOString().slice(0, 10), id_empleado || null, id_camion || null, observaciones || '')
    return id
  },

  cambiarEstado(id, estado) {
    const validos = ['borrador', 'confirmado', 'en_curso', 'finalizado']
    if (!validos.includes(estado)) throw new Error('Estado inválido.')
    db.prepare(`UPDATE circuitos SET estado = ? WHERE id = ?`).run(estado, id)
  },

  eliminar(id) {
    db.transaction(() => {
      db.prepare(`DELETE FROM circuito_paradas WHERE id_circuito = ?`).run(id)
      db.prepare(`DELETE FROM circuitos WHERE id = ?`).run(id)
    })()
  },

  // Operaciones pendientes/despachadas que aún no están en NINGÚN circuito
  operacionesDisponibles() {
    return db.prepare(`
      SELECT op.id, op.nro_op, op.tipo_op, op.estado,
             COALESCE(cli.nombre,'Particular') AS cliente_nombre,
             COALESCE(op.domicilio_calle,'') || ' ' || COALESCE(op.domicilio_altura,'') AS domicilio_m,
             dc.domicilio_entrega AS domicilio_c, dm.domicilio_entrega AS domicilio_ma
      FROM op_encabezado op
      LEFT JOIN clientes cli ON cli.id = op.id_cliente
      LEFT JOIN op_detalle_contenedor dc ON dc.id_orden_pedido = op.id
      LEFT JOIN op_detalle_maquinaria dm ON dm.id_orden_pedido = op.id
      WHERE op.estado IN ('pendiente','despachado')
        AND NOT EXISTS (SELECT 1 FROM circuito_paradas p WHERE p.id_op_encabezado = op.id)
      GROUP BY op.id
      ORDER BY op.fecha_entrega_planificada, op.created_at
    `).all().map(o => ({
      ...o,
      domicilio: (o.domicilio_m || '').trim() || o.domicilio_c || o.domicilio_ma || '',
    }))
  },

  agregarParada({ id_circuito, id_op_encabezado }) {
    const op = db.prepare(`SELECT tipo_op, domicilio_calle, domicilio_altura FROM op_encabezado WHERE id = ?`).get(id_op_encabezado)
    if (!op) throw new Error('Operación no encontrada.')
    const ya = db.prepare(`SELECT 1 FROM circuito_paradas WHERE id_op_encabezado = ?`).get(id_op_encabezado)
    if (ya) throw new Error('La operación ya está en un circuito.')
    let domicilio = [op.domicilio_calle, op.domicilio_altura].filter(Boolean).join(' ').trim()
    if (!domicilio) {
      const d = op.tipo_op === 'C'
        ? db.prepare(`SELECT domicilio_entrega FROM op_detalle_contenedor WHERE id_orden_pedido = ? LIMIT 1`).get(id_op_encabezado)
        : op.tipo_op === 'MA'
          ? db.prepare(`SELECT domicilio_entrega FROM op_detalle_maquinaria WHERE id_orden_pedido = ? LIMIT 1`).get(id_op_encabezado)
          : null
      domicilio = d ? d.domicilio_entrega : ''
    }
    const { n } = db.prepare(`SELECT COALESCE(MAX(orden),0)+1 AS n FROM circuito_paradas WHERE id_circuito = ?`).get(id_circuito)
    db.prepare(`INSERT INTO circuito_paradas (id, id_circuito, id_op_encabezado, orden, tipo_parada, domicilio, estado)
                VALUES (?, ?, ?, ?, ?, ?, 'pendiente')`)
      .run(crypto.randomUUID(), id_circuito, id_op_encabezado, n, TIPO_PARADA[op.tipo_op] || 'entrega_material', domicilio || '')
  },

  quitarParada(id) { db.prepare(`DELETE FROM circuito_paradas WHERE id = ?`).run(id) },

  estadoParada(id, estado) {
    const validos = ['pendiente', 'completada', 'cancelada']
    if (!validos.includes(estado)) throw new Error('Estado inválido.')
    db.prepare(`UPDATE circuito_paradas SET estado = ? WHERE id = ?`).run(estado, id)
  },

  choferes() {
    return db.prepare(`SELECT id, nombre, apellido FROM empleados WHERE activo = 1 AND es_chofer = 1 ORDER BY apellido, nombre`).all()
  },
  camiones() {
    return db.prepare(`SELECT id, nombre, patente FROM flota_vehiculos WHERE activo = 1 AND estado_operativo NOT IN ('inactivo','fuera_servicio') ORDER BY numero_interno, nombre`).all()
  },
}

module.exports = CircuitosModel
