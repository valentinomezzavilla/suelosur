'use strict'
const crypto = require('crypto')
const { query } = require('../config/db')

// Campos editables del empleado (whitelist para create/update)
const CAMPOS = [
  'nombre', 'apellido', 'dni', 'cuil', 'fecha_nacimiento', 'direccion', 'telefono', 'email',
  'contacto_emergencia', 'contacto_emergencia_tel',
  'cargo', 'sector', 'fecha_ingreso', 'estado_laboral', 'tipo_contratacion',
  'convenio', 'categoria_laboral', 'supervisor_id',
  'salario', 'sueldo_basico', 'bonificaciones', 'descuentos', 'viaticos', 'horas_extras',
  'vehiculo_asignado', 'es_chofer',
  'licencia_numero', 'licencia_categoria', 'licencia_fecha_emision', 'licencia_vencimiento', 'licencia_organismo',
  'certificaciones', 'id_usuario',
]
const NUMERICOS = new Set(['salario', 'sueldo_basico', 'bonificaciones', 'descuentos', 'viaticos', 'horas_extras'])
const BOOLEANOS = new Set(['es_chofer'])

function normalizar(datos) {
  const out = {}
  for (const c of CAMPOS) {
    let v = datos[c]
    if (NUMERICOS.has(c)) {
      out[c] = parseFloat(v) || 0
    } else if (BOOLEANOS.has(c)) {
      out[c] = (v === true || v === 'true' || v === 'on' || v === '1' || v === 1) ? 1 : 0
    } else {
      v = (v === undefined || v === null) ? '' : String(v).trim()
      out[c] = v === '' ? null : v
    }
  }
  if (!out.estado_laboral) out.estado_laboral = 'activo'
  return out
}

const EmpleadosModel = {

  async listar() {
    return (await query(`
      SELECT e.*, u.usuario AS usuario_sistema
      FROM empleados e
      LEFT JOIN users u ON u.id = e.id_usuario
      ORDER BY e.apellido, e.nombre
    `)).rows
  },

  async buscar({ q } = {}) {
    if (!q || !String(q).trim()) return await this.listar()
    const term = `%${String(q).trim()}%`
    return (await query(`
      SELECT e.*, u.usuario AS usuario_sistema
      FROM empleados e
      LEFT JOIN users u ON u.id = e.id_usuario
      WHERE e.nombre LIKE ? OR e.apellido LIKE ? OR e.dni LIKE ?
         OR e.cargo LIKE ? OR e.sector LIKE ? OR CAST(e.legajo AS TEXT) LIKE ?
      ORDER BY e.apellido, e.nombre
    `, [term, term, term, term, term, term])).rows
  },

  async obtener(id) {
    return (await query(`
      SELECT e.*, u.usuario AS usuario_sistema, u.nombre AS usuario_nombre
      FROM empleados e
      LEFT JOIN users u ON u.id = e.id_usuario
      WHERE e.id = ?
    `, [id])).rows[0]
  },

  async proximoLegajo() {
    const r = (await query(`SELECT COALESCE(MAX(legajo), 0) AS m FROM empleados`)).rows[0]
    return (r?.m || 0) + 1
  },

  async crear(datos) {
    const id = crypto.randomUUID()
    const legajo = await this.proximoLegajo()
    const d = normalizar(datos)
    const cols = ['id', 'legajo', ...CAMPOS]
    const vals = [id, legajo, ...CAMPOS.map(c => d[c])]
    const placeholders = cols.map(() => '?').join(', ')
    await query(`INSERT INTO empleados (${cols.join(', ')}) VALUES (${placeholders})`, vals)
    return id
  },

  async actualizar(id, datos) {
    const d = normalizar(datos)
    const sets = CAMPOS.map(c => `${c} = ?`).join(', ')
    const vals = [...CAMPOS.map(c => d[c]), id]
    await query(`UPDATE empleados SET ${sets} WHERE id = ?`, vals)
  },

  async toggleActivo(id) {
    await query(`UPDATE empleados SET activo = 1 - activo WHERE id = ?`, [id])
  },

  // Baja lógica con motivo / reingreso
  async darBaja(id, motivo) {
    await query(`UPDATE empleados SET activo = 0, estado_laboral = 'baja', fecha_baja = LEFT(to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'), 10), motivo_baja = ? WHERE id = ?`,
      [motivo || '', id])
  },

  async reingresar(id) {
    await query(`UPDATE empleados SET activo = 1, estado_laboral = 'activo', fecha_baja = NULL, motivo_baja = NULL WHERE id = ?`, [id])
  },

  // ── Choferes (es_chofer = 1) ──────────────────────────────────
  async listarChoferes({ q, soloActivos = false } = {}) {
    const wheres = ['e.es_chofer = 1']
    const params = []
    if (soloActivos) wheres.push('e.activo = 1')
    if (q && String(q).trim()) {
      const term = `%${String(q).trim()}%`
      wheres.push('(e.nombre LIKE ? OR e.apellido LIKE ? OR e.dni LIKE ? OR CAST(e.legajo AS TEXT) LIKE ?)')
      params.push(term, term, term, term)
    }
    return (await query(`
      SELECT e.*, u.usuario AS usuario_sistema,
        (SELECT COALESCE(v.nombre,'')||' ('||COALESCE(v.patente,'')||')'
         FROM asignaciones_recurso a JOIN flota_vehiculos v ON v.id = a.recurso_id
         WHERE a.id_empleado = e.id AND a.recurso_tipo = 'camion' AND a.activo = 1 LIMIT 1) AS camion_principal
      FROM empleados e
      LEFT JOIN users u ON u.id = e.id_usuario
      WHERE ${wheres.join(' AND ')}
      ORDER BY e.apellido, e.nombre
    `, params)).rows
  },

  // Empleados candidatos a supervisor (activos, distinto de uno mismo)
  async supervisores(excludeId = null) {
    if (excludeId) {
      return (await query(`
        SELECT id, nombre, apellido FROM empleados
        WHERE activo = 1 AND id != ? ORDER BY apellido, nombre
      `, [excludeId])).rows
    }
    return (await query(`
      SELECT id, nombre, apellido FROM empleados
      WHERE activo = 1 ORDER BY apellido, nombre
    `)).rows
  },

  // Usuarios del sistema disponibles para vincular (no asignados a otro empleado)
  async usuariosVinculables(empleadoId = null) {
    if (empleadoId) {
      return (await query(`
        SELECT u.id, u.usuario, u.nombre, u.rol
        FROM users u
        WHERE u.activo = 1
          AND u.id NOT IN (SELECT id_usuario FROM empleados WHERE id_usuario IS NOT NULL AND id != ?)
        ORDER BY u.nombre
      `, [empleadoId])).rows
    }
    return (await query(`
      SELECT u.id, u.usuario, u.nombre, u.rol
      FROM users u
      WHERE u.activo = 1
        AND u.id NOT IN (SELECT id_usuario FROM empleados WHERE id_usuario IS NOT NULL)
      ORDER BY u.nombre
    `)).rows
  },

  async dniEnUso(dni, excludeId = null) {
    if (!dni) return false
    if (excludeId) return !!(await query(`SELECT 1 FROM empleados WHERE dni = ? AND id != ?`, [dni, excludeId])).rows[0]
    return !!(await query(`SELECT 1 FROM empleados WHERE dni = ?`, [dni])).rows[0]
  },
}

module.exports = EmpleadosModel
