'use strict'
// Flota de camiones — CRUD + estados operativos con historial.
const crypto = require('crypto')
const { query, transaction } = require('../config/db')

const CAMPOS = [
  'tipo_vehiculo', 'patente', 'nombre', 'numero_interno', 'marca', 'modelo', 'anio',
  'nro_chasis', 'nro_motor', 'tipo_unidad', 'capacidad_carga', 'kilometraje', 'estado_operativo',
  'dedicacion', 'fecha_ultimo_mant', 'fecha_proximo_mant', 'observaciones',
]
const NUMERICOS = new Set(['anio', 'capacidad_carga', 'kilometraje', 'numero_interno'])

const ESTADOS = ['activo', 'disponible', 'en_viaje', 'en_mantenimiento', 'fuera_servicio', 'inactivo']
const DEDICACIONES = ['ambos', 'ventas', 'contenedores']

function normalizar(datos) {
  const out = {}
  for (const c of CAMPOS) {
    let v = datos[c]
    if (NUMERICOS.has(c)) out[c] = v === '' || v == null ? null : (parseFloat(v) || 0)
    else { v = (v == null) ? '' : String(v).trim(); out[c] = v === '' ? null : v }
  }
  if (!out.tipo_vehiculo) out.tipo_vehiculo = 'camion'
  if (!out.estado_operativo) out.estado_operativo = 'disponible'
  if (!out.dedicacion) out.dedicacion = 'ambos'
  return out
}

const FlotaModel = {
  ESTADOS,
  DEDICACIONES,

  async listar({ q, estado, tipo, marca, chofer } = {}) {
    const wheres = ['1=1']
    const params = []
    if (estado) { wheres.push('v.estado_operativo = ?'); params.push(estado) }
    if (tipo)   { wheres.push('v.tipo_unidad = ?');      params.push(tipo) }
    if (marca)  { wheres.push('v.marca = ?');            params.push(marca) }
    if (chofer) { wheres.push(`EXISTS (SELECT 1 FROM asignaciones_recurso a WHERE a.recurso_tipo='camion' AND a.recurso_id=v.id AND a.activo=1 AND a.id_empleado=?)`); params.push(chofer) }
    if (q && String(q).trim()) {
      const term = `%${String(q).trim()}%`
      wheres.push('(v.nombre ILIKE? OR v.patente ILIKE? OR v.marca ILIKE? OR v.modelo ILIKE? OR CAST(v.numero_interno AS TEXT) ILIKE?)')
      params.push(term, term, term, term, term)
    }
    return (await query(`
      SELECT v.*,
        (SELECT (e.nombre || ' ' || COALESCE(e.apellido,'')) FROM asignaciones_recurso a JOIN empleados e ON e.id=a.id_empleado
         WHERE a.recurso_tipo='camion' AND a.recurso_id=v.id AND a.activo=1 LIMIT 1) AS chofer_nombre
      FROM flota_vehiculos v
      WHERE ${wheres.join(' AND ')} ORDER BY v.activo DESC, v.numero_interno, v.nombre
    `, params)).rows
  },

  async obtener(id) {
    return (await query(`
      SELECT v.*,
        (SELECT (e.nombre || ' ' || COALESCE(e.apellido,'')) FROM asignaciones_recurso a JOIN empleados e ON e.id=a.id_empleado
         WHERE a.recurso_tipo='camion' AND a.recurso_id=v.id AND a.activo=1 LIMIT 1) AS chofer_nombre,
        (SELECT a.id_empleado FROM asignaciones_recurso a WHERE a.recurso_tipo='camion' AND a.recurso_id=v.id AND a.activo=1 LIMIT 1) AS chofer_id
      FROM flota_vehiculos v WHERE v.id = ?
    `, [id])).rows[0]
  },

  // Validaciones de unicidad
  async patenteEnUso(patente, excludeId = null) {
    if (!patente) return false
    return !!(await query(`SELECT 1 FROM flota_vehiculos WHERE patente = ? AND id != ?`, [patente, excludeId || ''])).rows[0]
  },
  async numeroInternoEnUso(numero, excludeId = null) {
    if (!numero) return false
    return !!(await query(`SELECT 1 FROM flota_vehiculos WHERE numero_interno = ? AND id != ?`, [numero, excludeId || ''])).rows[0]
  },

  async crear(datos) {
    const d = normalizar(datos)
    if (await this.patenteEnUso(d.patente)) throw new Error(`Ya existe un camión con la patente ${d.patente}.`)
    if (await this.numeroInternoEnUso(d.numero_interno)) throw new Error(`Ya existe un camión con el número interno ${d.numero_interno}.`)
    const id = crypto.randomUUID()
    const cols = ['id', ...CAMPOS]
    await query(`INSERT INTO flota_vehiculos (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
      [id, ...CAMPOS.map(c => d[c])])
    await this.registrarEstado(id, d.estado_operativo, null, 'Alta inicial')
    return id
  },

  async actualizar(id, datos) {
    const d = normalizar(datos)
    if (await this.patenteEnUso(d.patente, id)) throw new Error(`Ya existe otro camión con la patente ${d.patente}.`)
    if (await this.numeroInternoEnUso(d.numero_interno, id)) throw new Error(`Ya existe otro camión con el número interno ${d.numero_interno}.`)
    await query(`UPDATE flota_vehiculos SET ${CAMPOS.map(c => `${c}=?`).join(',')} WHERE id = ?`,
      [...CAMPOS.map(c => d[c]), id])
  },

  async toggleActivo(id) {
    await query(`UPDATE flota_vehiculos SET activo = 1 - activo WHERE id = ?`, [id])
  },

  async registrarEstado(id, estado, usuarioId, obs) {
    await query(`INSERT INTO estado_vehiculo_hist (id, id_vehiculo, estado, id_usuario, observaciones) VALUES (?, ?, ?, ?, ?)`,
      [crypto.randomUUID(), id, estado, usuarioId || null, obs || ''])
  },

  async cambiarEstado(id, estado, usuarioId, obs) {
    if (!ESTADOS.includes(estado)) throw new Error('Estado inválido.')
    await transaction(async (q) => {
      await q(`UPDATE flota_vehiculos SET estado_operativo = ? WHERE id = ?`, [estado, id])
      await q(`INSERT INTO estado_vehiculo_hist (id, id_vehiculo, estado, id_usuario, observaciones) VALUES (?, ?, ?, ?, ?)`,
        [crypto.randomUUID(), id, estado, usuarioId || null, obs || ''])
    })
  },

  async historialEstados(id) {
    return (await query(`
      SELECT h.*, u.nombre AS usuario_nombre FROM estado_vehiculo_hist h
      LEFT JOIN users u ON u.id = h.id_usuario
      WHERE h.id_vehiculo = ? ORDER BY h.fecha DESC
    `, [id])).rows
  },

  // Métricas de disponibilidad de flota (para dashboard/reportes)
  async resumenFlota() {
    const rows = (await query(`SELECT estado_operativo AS estado, COUNT(*) AS n FROM flota_vehiculos WHERE activo = 1 GROUP BY estado_operativo`)).rows
    const porEstado = {}
    rows.forEach(r => { porEstado[r.estado] = r.n })
    const total = (await query(`SELECT COUNT(*) AS n FROM flota_vehiculos WHERE activo = 1`)).rows[0]?.n || 0
    return { total, porEstado }
  },

  // Opciones para filtros (tipos de unidad y marcas existentes)
  async opcionesFiltro() {
    const tipos  = (await query(`SELECT DISTINCT tipo_unidad AS v FROM flota_vehiculos WHERE tipo_unidad IS NOT NULL AND tipo_unidad != '' ORDER BY tipo_unidad`)).rows.map(r => r.v)
    const marcas = (await query(`SELECT DISTINCT marca AS v FROM flota_vehiculos WHERE marca IS NOT NULL AND marca != '' ORDER BY marca`)).rows.map(r => r.v)
    return { tipos, marcas }
  },

  // Vista de disponibilidad: camiones clasificados por situación
  async disponibilidad() {
    return (await query(`
      SELECT v.id, v.numero_interno, v.patente, v.nombre, v.marca, v.modelo, v.estado_operativo,
        (SELECT (e.nombre || ' ' || COALESCE(e.apellido,'')) FROM asignaciones_recurso a JOIN empleados e ON e.id=a.id_empleado
         WHERE a.recurso_tipo='camion' AND a.recurso_id=v.id AND a.activo=1 LIMIT 1) AS chofer_nombre
      FROM flota_vehiculos v WHERE v.activo = 1 ORDER BY v.numero_interno, v.nombre
    `)).rows.map(v => {
      let situacion
      if (['en_mantenimiento', 'fuera_servicio', 'inactivo'].includes(v.estado_operativo)) situacion = 'mantenimiento'
      else if (v.chofer_nombre) situacion = 'asignado'
      else situacion = 'disponible'
      return { ...v, situacion }
    })
  },
}

module.exports = FlotaModel
