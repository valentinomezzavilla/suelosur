'use strict'
const crypto = require('crypto')
const db = require('../config/db')

// Sub-query reutilizable — último movimiento por máquina
const SQL_ULTIMO_MOV = `
  SELECT m.* FROM (
    SELECT m.*, ROW_NUMBER() OVER (PARTITION BY id_maquinaria ORDER BY fecha_movimiento DESC, rowid DESC) AS rn
    FROM movimiento_maquinaria m
  ) m WHERE m.rn = 1
`

const MaquinariaModel = {

  // ── Catálogo ──────────────────────────────────────────────────
  listar({ estado_paso, estado_general } = {}) {
    const wheres = ['m.activo = 1']
    const params = []
    if (estado_general) { wheres.push('m.estado_general = ?'); params.push(estado_general) }
    if (estado_paso)    { wheres.push('um.estado_paso = ?');   params.push(estado_paso) }
    return db.prepare(`
      SELECT m.id, m.nombre, m.tipo, m.patente, m.modelo, m.anio, m.estado_general,
             m.km_actuales, m.ultimo_service, m.proximo_service, m.observaciones, m.activo,
             um.estado_paso, um.fecha_movimiento,
             op.nro_op, cli.nombre AS cliente_nombre,
             opm.domicilio_entrega, opm.zona_entrega, opm.plazo_alquiler,
             CAST((julianday('now') - julianday(um.fecha_movimiento)) AS INTEGER) AS dias_en_estado
      FROM maquinaria m
      LEFT JOIN (${SQL_ULTIMO_MOV}) um ON um.id_maquinaria = m.id
      LEFT JOIN op_detalle_maquinaria opm ON opm.id = um.id_op_maquinaria
      LEFT JOIN op_encabezado op ON op.id = opm.id_orden_pedido
      LEFT JOIN clientes cli ON cli.id = op.id_cliente
      WHERE ${wheres.join(' AND ')} ORDER BY m.nombre
    `).all(...params)
  },

  obtener(id) {
    const m = db.prepare(`SELECT * FROM maquinaria WHERE id = ?`).get(id)
    if (!m) return null
    m.movimientos = db.prepare(`
      SELECT mv.*, u.nombre AS operario_nombre, f.patente AS camion_patente, f.nombre AS camion_nombre,
             op.nro_op, cli.nombre AS cliente_nombre, opm.domicilio_entrega, opm.zona_entrega
      FROM movimiento_maquinaria mv
      LEFT JOIN users u ON u.id = mv.id_operario
      LEFT JOIN flota_vehiculos f ON f.id = mv.id_camion
      LEFT JOIN op_detalle_maquinaria opm ON opm.id = mv.id_op_maquinaria
      LEFT JOIN op_encabezado op ON op.id = opm.id_orden_pedido
      LEFT JOIN clientes cli ON cli.id = op.id_cliente
      WHERE mv.id_maquinaria = ? ORDER BY mv.fecha_movimiento DESC, mv.rowid DESC
    `).all(id)
    m.mantenimientos = db.prepare(`SELECT * FROM mantenimiento_maquinaria WHERE id_maquinaria = ? ORDER BY fecha DESC`).all(id)
    return m
  },

  obtenerPorNombre(nombre) {
    return db.prepare(`SELECT * FROM maquinaria WHERE nombre = ? AND activo = 1`).get(nombre)
  },

  crear({ nombre, tipo, patente, modelo, anio, estado_general, km_actuales, observaciones }) {
    const id = crypto.randomUUID()
    db.transaction(() => {
      db.prepare(`
        INSERT INTO maquinaria (id, nombre, tipo, patente, modelo, anio, estado_general, km_actuales, observaciones)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, nombre, tipo || 'bobcat', patente || null, modelo || null,
             anio ? parseInt(anio) : null, estado_general || 'operativo',
             km_actuales ? parseInt(km_actuales) : 0, observaciones || '')
      db.prepare(`INSERT INTO movimiento_maquinaria (id, id_maquinaria, estado_paso, observaciones) VALUES (?, ?, 'en_planta', 'Alta inicial')`
      ).run(crypto.randomUUID(), id)
    })()
    return id
  },

  actualizar(id, datos) {
    db.prepare(`
      UPDATE maquinaria SET nombre = ?, tipo = ?, patente = ?, modelo = ?, anio = ?,
        estado_general = ?, km_actuales = ?, observaciones = ?,
        ultimo_service = ?, proximo_service = ?
      WHERE id = ?
    `).run(datos.nombre, datos.tipo || 'bobcat', datos.patente || null, datos.modelo || null,
           datos.anio ? parseInt(datos.anio) : null, datos.estado_general || 'operativo',
           datos.km_actuales ? parseInt(datos.km_actuales) : 0, datos.observaciones || '',
           datos.ultimo_service || null, datos.proximo_service || null, id)
  },

  toggleActivo(id) {
    db.prepare(`UPDATE maquinaria SET activo = NOT activo WHERE id = ?`).run(id)
  },

  registrarMovimiento({ id_maquinaria, id_op_maquinaria, id_operario, id_camion, estado_paso, horas_trabajadas, km_registrados, observaciones, fecha_movimiento }) {
    db.prepare(`
      INSERT INTO movimiento_maquinaria
        (id, id_maquinaria, id_op_maquinaria, id_operario, id_camion, fecha_movimiento, estado_paso, horas_trabajadas, km_registrados, observaciones)
      VALUES (?, ?, ?, ?, ?, COALESCE(?, datetime('now')), ?, ?, ?, ?)
    `).run(crypto.randomUUID(), id_maquinaria, id_op_maquinaria || null,
           id_operario || null, id_camion || null, fecha_movimiento || null,
           estado_paso, parseFloat(horas_trabajadas) || 0,
           parseInt(km_registrados) || 0, observaciones || '')
  },

  registrarMantenimiento({ id_maquinaria, tipo_service, fecha, costo, km_al_service, proximo_fecha, taller, descripcion }) {
    db.prepare(`
      INSERT INTO mantenimiento_maquinaria (id, id_maquinaria, tipo_service, fecha, costo, km_al_service, proximo_fecha, taller, descripcion)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(crypto.randomUUID(), id_maquinaria, tipo_service || 'preventivo',
           fecha, parseFloat(costo) || 0, parseInt(km_al_service) || 0,
           proximo_fecha || null, taller || '', descripcion || '')
    if (proximo_fecha) {
      db.prepare(`UPDATE maquinaria SET ultimo_service = ?, proximo_service = ? WHERE id = ?`
      ).run(fecha, proximo_fecha, id_maquinaria)
    }
  },

  disponibles() {
    return db.prepare(`
      SELECT m.id, m.nombre, m.tipo, m.precio_por_hora, m.precio_por_dia, m.modo_precio
      FROM maquinaria m
      JOIN (${SQL_ULTIMO_MOV}) um ON um.id_maquinaria = m.id
      WHERE m.activo = 1 AND m.estado_general = 'operativo' AND um.estado_paso = 'en_planta'
      ORDER BY m.nombre
    `).all()
  },

  choferes() {
    return db.prepare(`SELECT id, nombre FROM users WHERE rol = 'chofer' AND activo = 1 ORDER BY nombre`).all()
  },

  resumenPorEstado() {
    return db.prepare(`
      SELECT um.estado_paso, COUNT(*) AS total FROM maquinaria m
      JOIN (${SQL_ULTIMO_MOV}) um ON um.id_maquinaria = m.id
      WHERE m.activo = 1 GROUP BY um.estado_paso
    `).all()
  },

  operarios() {
    return db.prepare(`SELECT id, nombre FROM users WHERE rol IN ('chofer','admin_ventas','dueno') AND activo = 1 ORDER BY nombre`).all()
  },

  camiones() {
    return db.prepare(`SELECT id, patente, nombre FROM flota_vehiculos WHERE activo = 1 ORDER BY nombre`).all()
  },

  clientes() {
    return db.prepare(`SELECT id, nombre FROM clientes WHERE activo = 1 ORDER BY nombre`).all()
  },
}

module.exports = MaquinariaModel
