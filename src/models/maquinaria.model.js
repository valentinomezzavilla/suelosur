'use strict'
const crypto = require('crypto')
const { query, transaction } = require('../config/db')

// Sub-query reutilizable — último movimiento por máquina
const SQL_ULTIMO_MOV = `
  SELECT m.* FROM (
    SELECT m.*, ROW_NUMBER() OVER (PARTITION BY id_maquinaria ORDER BY fecha_movimiento DESC) AS rn
    FROM movimiento_maquinaria m
  ) m WHERE m.rn = 1
`

const MaquinariaModel = {

  // ── Catálogo ──────────────────────────────────────────────────
  async listar({ estado_paso, estado_general } = {}) {
    const wheres = ['m.activo = 1']
    const params = []
    if (estado_general) { wheres.push('m.estado_general = ?'); params.push(estado_general) }
    if (estado_paso)    { wheres.push('um.estado_paso = ?');   params.push(estado_paso) }
    return (await query(`
      SELECT m.id, m.nombre, m.tipo, m.patente, m.modelo, m.anio, m.estado_general,
             m.km_actuales, m.ultimo_service, m.proximo_service, m.observaciones, m.activo,
             um.estado_paso, um.fecha_movimiento,
             op.nro_op, cli.nombre AS cliente_nombre,
             opm.domicilio_entrega, opm.zona_entrega, opm.plazo_alquiler,
             CAST((NOW() - um.fecha_movimiento::timestamp) AS INTEGER) AS dias_en_estado
      FROM maquinaria m
      LEFT JOIN (${SQL_ULTIMO_MOV}) um ON um.id_maquinaria = m.id
      LEFT JOIN op_detalle_maquinaria opm ON opm.id = um.id_op_maquinaria
      LEFT JOIN op_encabezado op ON op.id = opm.id_orden_pedido
      LEFT JOIN clientes cli ON cli.id = op.id_cliente
      WHERE ${wheres.join(' AND ')} ORDER BY m.nombre
    `, params)).rows
  },

  async obtener(id) {
    const result = await query(`SELECT * FROM maquinaria WHERE id = ?`, [id])
    const m = result.rows[0]
    if (!m) return null
    m.asignaciones = (await query(`
      SELECT a.*, (e.nombre || ' ' || COALESCE(e.apellido,'')) AS empleado_nombre, e.legajo
      FROM asignaciones_recurso a JOIN empleados e ON e.id = a.id_empleado
      WHERE a.recurso_tipo = 'maquina' AND a.recurso_id = ? ORDER BY a.activo DESC, a.fecha_desde DESC
    `, [id])).rows
    m.chofer_asignado = m.asignaciones.find(a => a.activo) || null
    m.movimientos = (await query(`
      SELECT mv.*, u.nombre AS operario_nombre, f.patente AS camion_patente, f.nombre AS camion_nombre,
             op.nro_op, cli.nombre AS cliente_nombre, opm.domicilio_entrega, opm.zona_entrega
      FROM movimiento_maquinaria mv
      LEFT JOIN users u ON u.id = mv.id_operario
      LEFT JOIN flota_vehiculos f ON f.id = mv.id_camion
      LEFT JOIN op_detalle_maquinaria opm ON opm.id = mv.id_op_maquinaria
      LEFT JOIN op_encabezado op ON op.id = opm.id_orden_pedido
      LEFT JOIN clientes cli ON cli.id = op.id_cliente
      WHERE mv.id_maquinaria = ? ORDER BY mv.fecha_movimiento DESC
    `, [id])).rows
    m.mantenimientos = (await query(`SELECT * FROM mantenimiento_maquinaria WHERE id_maquinaria = ? ORDER BY fecha DESC`, [id])).rows
    return m
  },

  async obtenerPorNombre(nombre) {
    return (await query(`SELECT * FROM maquinaria WHERE nombre = ? AND activo = 1`, [nombre])).rows[0]
  },

  ESTADOS_OP: ['disponible', 'en_operacion', 'en_mantenimiento', 'fuera_servicio'],

  async patenteEnUso(patente, excludeId = null) {
    if (!patente) return false
    return !!(await query(`SELECT 1 FROM maquinaria WHERE patente = ? AND id != ?`, [patente, excludeId || ''])).rows[0]
  },
  async numeroInternoEnUso(numero, excludeId = null) {
    if (!numero) return false
    return !!(await query(`SELECT 1 FROM maquinaria WHERE numero_interno = ? AND id != ?`, [numero, excludeId || ''])).rows[0]
  },

  async crear(datos) {
    const { nombre, tipo, patente, marca, modelo, anio, estado_general, estado_operativo,
            km_actuales, horas_uso, numero_interno, observaciones, ultimo_service, proximo_service } = datos
    if (await this.patenteEnUso(patente)) throw new Error(`Ya existe una máquina con la patente ${patente}.`)
    if (numero_interno && await this.numeroInternoEnUso(numero_interno)) throw new Error(`Ya existe una máquina con el número interno ${numero_interno}.`)
    const id = crypto.randomUUID()
    await transaction(async (q) => {
      await q(`
        INSERT INTO maquinaria (id, nombre, tipo, patente, marca, modelo, anio, estado_general, estado_operativo,
          km_actuales, horas_uso, numero_interno, observaciones, ultimo_service, proximo_service)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [id, nombre, tipo || 'bobcat', patente || null, marca || null, modelo || null,
          anio ? parseInt(anio) : null, estado_general || 'operativo', estado_operativo || 'disponible',
          km_actuales ? parseInt(km_actuales) : 0, horas_uso ? parseFloat(horas_uso) : 0,
          numero_interno ? parseInt(numero_interno) : null, observaciones || '',
          ultimo_service || null, proximo_service || null])
      await q(`INSERT INTO movimiento_maquinaria (id, id_maquinaria, estado_paso, observaciones) VALUES (?, ?, 'en_planta', 'Alta inicial')`,
        [crypto.randomUUID(), id])
    })
    return id
  },

  async actualizar(id, datos) {
    if (await this.patenteEnUso(datos.patente, id)) throw new Error(`Ya existe otra máquina con la patente ${datos.patente}.`)
    if (datos.numero_interno && await this.numeroInternoEnUso(datos.numero_interno, id)) throw new Error(`Ya existe otra máquina con el número interno ${datos.numero_interno}.`)
    await query(`
      UPDATE maquinaria SET nombre = ?, tipo = ?, patente = ?, marca = ?, modelo = ?, anio = ?,
        estado_general = ?, estado_operativo = ?, km_actuales = ?, horas_uso = ?, numero_interno = ?,
        observaciones = ?, ultimo_service = ?, proximo_service = ?
      WHERE id = ?
    `, [datos.nombre, datos.tipo || 'bobcat', datos.patente || null, datos.marca || null, datos.modelo || null,
        datos.anio ? parseInt(datos.anio) : null, datos.estado_general || 'operativo',
        datos.estado_operativo || 'disponible', datos.km_actuales ? parseInt(datos.km_actuales) : 0,
        datos.horas_uso ? parseFloat(datos.horas_uso) : 0,
        datos.numero_interno ? parseInt(datos.numero_interno) : null,
        datos.observaciones || '', datos.ultimo_service || null, datos.proximo_service || null, id])
  },

  // Vista de disponibilidad: máquinas clasificadas por situación
  async disponibilidad() {
    return (await query(`
      SELECT m.id, m.numero_interno, m.nombre, m.tipo, m.marca, m.modelo, m.estado_operativo,
        (SELECT (e.nombre || ' ' || COALESCE(e.apellido,'')) FROM asignaciones_recurso a JOIN empleados e ON e.id=a.id_empleado
         WHERE a.recurso_tipo='maquina' AND a.recurso_id=m.id AND a.activo=1 LIMIT 1) AS chofer_nombre
      FROM maquinaria m WHERE m.activo = 1 ORDER BY m.numero_interno, m.nombre
    `)).rows.map(m => {
      let situacion
      if (['en_mantenimiento', 'fuera_servicio'].includes(m.estado_operativo)) situacion = 'mantenimiento'
      else if (m.chofer_nombre) situacion = 'asignado'
      else situacion = 'disponible'
      return { ...m, situacion }
    })
  },

  async toggleActivo(id) {
    await query(`UPDATE maquinaria SET activo = 1 - activo WHERE id = ?`, [id])
  },

  async registrarMovimiento({ id_maquinaria, id_op_maquinaria, id_operario, id_camion, estado_paso, horas_trabajadas, km_registrados, observaciones, fecha_movimiento }) {
    await query(`
      INSERT INTO movimiento_maquinaria
        (id, id_maquinaria, id_op_maquinaria, id_operario, id_camion, fecha_movimiento, estado_paso, horas_trabajadas, km_registrados, observaciones)
      VALUES (?, ?, ?, ?, ?, COALESCE(?, to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')), ?, ?, ?, ?)
    `, [crypto.randomUUID(), id_maquinaria, id_op_maquinaria || null,
        id_operario || null, id_camion || null, fecha_movimiento || null,
        estado_paso, parseFloat(horas_trabajadas) || 0,
        parseInt(km_registrados) || 0, observaciones || ''])
  },

  async registrarMantenimiento({ id_maquinaria, tipo_service, fecha, costo, km_al_service, proximo_fecha, taller, descripcion }) {
    await query(`
      INSERT INTO mantenimiento_maquinaria (id, id_maquinaria, tipo_service, fecha, costo, km_al_service, proximo_fecha, taller, descripcion)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [crypto.randomUUID(), id_maquinaria, tipo_service || 'preventivo',
        fecha, parseFloat(costo) || 0, parseInt(km_al_service) || 0,
        proximo_fecha || null, taller || '', descripcion || ''])
    if (proximo_fecha) {
      await query(`UPDATE maquinaria SET ultimo_service = ?, proximo_service = ? WHERE id = ?`,
        [fecha, proximo_fecha, id_maquinaria])
    }
  },

  async disponibles() {
    return (await query(`
      SELECT m.id, m.nombre, m.tipo, m.precio_por_hora, m.precio_por_dia, m.modo_precio
      FROM maquinaria m
      JOIN (${SQL_ULTIMO_MOV}) um ON um.id_maquinaria = m.id
      WHERE m.activo = 1 AND m.estado_general = 'operativo' AND um.estado_paso = 'en_planta'
      ORDER BY m.nombre
    `)).rows
  },

  async choferes() {
    return (await query(`SELECT id, nombre FROM users WHERE rol = 'chofer' AND activo = 1 ORDER BY nombre`)).rows
  },

  async resumenPorEstado() {
    return (await query(`
      SELECT um.estado_paso, COUNT(*) AS total FROM maquinaria m
      JOIN (${SQL_ULTIMO_MOV}) um ON um.id_maquinaria = m.id
      WHERE m.activo = 1 GROUP BY um.estado_paso
    `)).rows
  },

  async operarios() {
    return (await query(`SELECT id, nombre FROM users WHERE rol IN ('chofer','admin_ventas','dueno') AND activo = 1 ORDER BY nombre`)).rows
  },

  async camiones() {
    return (await query(`SELECT id, patente, nombre FROM flota_vehiculos WHERE activo = 1 ORDER BY nombre`)).rows
  },

  async clientes() {
    return (await query(`SELECT id, nombre FROM clientes WHERE activo = 1 ORDER BY nombre`)).rows
  },
}

module.exports = MaquinariaModel
