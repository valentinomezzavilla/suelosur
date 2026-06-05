'use strict'
const crypto = require('crypto')
const db = require('../config/db')

const SQL_ULTIMO_MOV = `
  SELECT m.* FROM (
    SELECT m.*, ROW_NUMBER() OVER (PARTITION BY id_contenedor ORDER BY fecha_movimiento DESC, rowid DESC) AS rn
    FROM movimiento_contenedor m
  ) m WHERE m.rn = 1
`

const ContenedoresModel = {

  listar({ estado_paso, estado_general } = {}) {
    const wheres = ['c.activo = 1']
    const params = []
    if (estado_general) { wheres.push('c.estado_general = ?'); params.push(estado_general) }
    if (estado_paso)    { wheres.push('um.estado_paso = ?');   params.push(estado_paso) }
    return db.prepare(`
      SELECT c.id, c.numero_contenedor, c.estado_general, c.fecha_ultima_pintada,
             c.observaciones, c.activo, um.estado_paso, um.fecha_movimiento,
             oc.domicilio_entrega, oc.zona_entrega, oc.plazo_alquiler,
             cli.nombre AS cliente_nombre, op.nro_op,
             CAST((julianday('now') - julianday(um.fecha_movimiento)) AS INTEGER) AS dias_en_estado
      FROM contenedores c
      LEFT JOIN (${SQL_ULTIMO_MOV}) um ON um.id_contenedor = c.id
      LEFT JOIN op_detalle_contenedor oc ON oc.id = um.id_op_contenedor
      LEFT JOIN op_encabezado op ON op.id = oc.id_orden_pedido
      LEFT JOIN clientes cli ON cli.id = op.id_cliente
      WHERE ${wheres.join(' AND ')} ORDER BY c.numero_contenedor
    `).all(...params)
  },

  obtener(id) {
    const c = db.prepare(`SELECT * FROM contenedores WHERE id = ?`).get(id)
    if (!c) return null
    c.movimientos = db.prepare(`
      SELECT m.*, u.nombre AS chofer_nombre, f.patente AS camion_patente, f.nombre AS camion_nombre,
             op.nro_op, cli.nombre AS cliente_nombre, oc.domicilio_entrega, oc.zona_entrega
      FROM movimiento_contenedor m
      LEFT JOIN users u ON u.id = m.id_chofer
      LEFT JOIN flota_vehiculos f ON f.id = m.id_camion
      LEFT JOIN op_detalle_contenedor oc ON oc.id = m.id_op_contenedor
      LEFT JOIN op_encabezado op ON op.id = oc.id_orden_pedido
      LEFT JOIN clientes cli ON cli.id = op.id_cliente
      WHERE m.id_contenedor = ? ORDER BY m.fecha_movimiento DESC, m.rowid DESC
    `).all(id)
    return c
  },

  obtenerPorNumero(numero) {
    return db.prepare(`SELECT * FROM contenedores WHERE numero_contenedor = ?`).get(numero)
  },

  crear({ numero_contenedor, estado_general, fecha_ultima_pintada, observaciones }) {
    const id = crypto.randomUUID()
    db.transaction(() => {
      db.prepare(`INSERT INTO contenedores (id, numero_contenedor, estado_general, fecha_ultima_pintada, observaciones) VALUES (?, ?, ?, ?, ?)`
      ).run(id, numero_contenedor, estado_general || 'operativo', fecha_ultima_pintada || null, observaciones || '')
      db.prepare(`INSERT INTO movimiento_contenedor (id, id_contenedor, estado_paso, observaciones) VALUES (?, ?, 'en_planta', 'Alta inicial')`
      ).run(crypto.randomUUID(), id)
    })()
    return id
  },

  actualizar(id, { numero_contenedor, estado_general, fecha_ultima_pintada, observaciones }) {
    db.prepare(`UPDATE contenedores SET numero_contenedor = ?, estado_general = ?, fecha_ultima_pintada = ?, observaciones = ? WHERE id = ?`
    ).run(numero_contenedor, estado_general || 'operativo', fecha_ultima_pintada || null, observaciones || '', id)
  },

  toggleActivo(id) {
    db.prepare(`UPDATE contenedores SET activo = NOT activo WHERE id = ?`).run(id)
  },

  registrarMovimiento({ id_contenedor, id_op_contenedor, id_chofer, id_camion, estado_paso, observaciones, fecha_movimiento }) {
    db.prepare(`
      INSERT INTO movimiento_contenedor (id, id_contenedor, id_op_contenedor, id_chofer, id_camion, fecha_movimiento, estado_paso, observaciones)
      VALUES (?, ?, ?, ?, ?, COALESCE(?, datetime('now')), ?, ?)
    `).run(crypto.randomUUID(), id_contenedor, id_op_contenedor || null,
           id_chofer || null, id_camion || null, fecha_movimiento || null,
           estado_paso, observaciones || '')
  },

  disponibles() {
    return db.prepare(`
      SELECT c.id, c.numero_contenedor FROM contenedores c
      JOIN (${SQL_ULTIMO_MOV}) um ON um.id_contenedor = c.id
      WHERE c.activo = 1 AND c.estado_general = 'operativo' AND um.estado_paso IN ('en_planta','vaciado')
      ORDER BY c.numero_contenedor
    `).all()
  },

  resumenPorEstado() {
    return db.prepare(`
      SELECT um.estado_paso, COUNT(*) AS total FROM contenedores c
      JOIN (${SQL_ULTIMO_MOV}) um ON um.id_contenedor = c.id
      WHERE c.activo = 1 GROUP BY um.estado_paso
    `).all()
  },

  circuitoDiario() {
    return db.prepare(`
      SELECT c.id, c.numero_contenedor, um.estado_paso, um.fecha_movimiento,
             oc.id AS id_op_contenedor, oc.domicilio_entrega, oc.zona_entrega, oc.plazo_alquiler,
             cli.nombre AS cliente_nombre, cli.tel_whatsapp, op.nro_op,
             CAST((julianday('now') - julianday(um.fecha_movimiento)) AS INTEGER) AS dias_en_domicilio,
             (CAST((julianday('now') - julianday(um.fecha_movimiento)) AS INTEGER) - oc.plazo_alquiler) AS dias_excedidos
      FROM contenedores c
      JOIN (${SQL_ULTIMO_MOV}) um ON um.id_contenedor = c.id
      JOIN op_detalle_contenedor oc ON oc.id = um.id_op_contenedor
      JOIN op_encabezado op ON op.id = oc.id_orden_pedido
      JOIN clientes cli ON cli.id = op.id_cliente
      WHERE c.activo = 1 AND um.estado_paso IN ('entregado','en_alquiler','a_retirar')
        AND CAST((julianday('now') - julianday(um.fecha_movimiento)) AS INTEGER) >= oc.plazo_alquiler
      ORDER BY oc.zona_entrega, dias_excedidos DESC
    `).all()
  },

  choferes() {
    return db.prepare(`SELECT id, nombre FROM users WHERE rol = 'chofer' AND activo = 1 ORDER BY nombre`).all()
  },

  camiones() {
    return db.prepare(`SELECT id, patente, nombre FROM flota_vehiculos WHERE tipo_vehiculo = 'camion' AND activo = 1 ORDER BY nombre`).all()
  },
}

module.exports = ContenedoresModel
