'use strict'
const crypto = require('crypto')
const db = require('../config/db')

// Campos editables del empleado (whitelist para create/update)
const CAMPOS = [
  'nombre', 'apellido', 'dni', 'fecha_nacimiento', 'direccion', 'telefono', 'email',
  'cargo', 'sector', 'fecha_ingreso', 'estado_laboral', 'tipo_contratacion',
  'salario', 'bonificaciones', 'descuentos', 'viaticos', 'horas_extras',
  'vehiculo_asignado', 'licencia_categoria', 'licencia_vencimiento', 'certificaciones',
  'id_usuario',
]
const NUMERICOS = new Set(['salario', 'bonificaciones', 'descuentos', 'viaticos', 'horas_extras'])

function normalizar(datos) {
  const out = {}
  for (const c of CAMPOS) {
    let v = datos[c]
    if (NUMERICOS.has(c)) {
      out[c] = parseFloat(v) || 0
    } else {
      v = (v === undefined || v === null) ? '' : String(v).trim()
      out[c] = v === '' ? null : v
    }
  }
  if (!out.estado_laboral) out.estado_laboral = 'activo'
  return out
}

const EmpleadosModel = {

  listar() {
    return db.prepare(`
      SELECT e.*, u.usuario AS usuario_sistema
      FROM empleados e
      LEFT JOIN users u ON u.id = e.id_usuario
      ORDER BY e.apellido, e.nombre
    `).all()
  },

  buscar({ q } = {}) {
    if (!q || !String(q).trim()) return this.listar()
    const term = `%${String(q).trim()}%`
    return db.prepare(`
      SELECT e.*, u.usuario AS usuario_sistema
      FROM empleados e
      LEFT JOIN users u ON u.id = e.id_usuario
      WHERE e.nombre LIKE ? OR e.apellido LIKE ? OR e.dni LIKE ?
         OR e.cargo LIKE ? OR e.sector LIKE ? OR CAST(e.legajo AS TEXT) LIKE ?
      ORDER BY e.apellido, e.nombre
    `).all(term, term, term, term, term, term)
  },

  obtener(id) {
    return db.prepare(`
      SELECT e.*, u.usuario AS usuario_sistema, u.nombre AS usuario_nombre
      FROM empleados e
      LEFT JOIN users u ON u.id = e.id_usuario
      WHERE e.id = ?
    `).get(id)
  },

  proximoLegajo() {
    const r = db.prepare(`SELECT COALESCE(MAX(legajo), 0) AS m FROM empleados`).get()
    return (r.m || 0) + 1
  },

  crear(datos) {
    const id = crypto.randomUUID()
    const legajo = this.proximoLegajo()
    const d = normalizar(datos)
    const cols = ['id', 'legajo', ...CAMPOS]
    const vals = [id, legajo, ...CAMPOS.map(c => d[c])]
    const placeholders = cols.map(() => '?').join(', ')
    db.prepare(`INSERT INTO empleados (${cols.join(', ')}) VALUES (${placeholders})`).run(...vals)
    return id
  },

  actualizar(id, datos) {
    const d = normalizar(datos)
    const sets = CAMPOS.map(c => `${c} = ?`).join(', ')
    const vals = [...CAMPOS.map(c => d[c]), id]
    db.prepare(`UPDATE empleados SET ${sets} WHERE id = ?`).run(...vals)
  },

  toggleActivo(id) {
    db.prepare(`UPDATE empleados SET activo = NOT activo WHERE id = ?`).run(id)
  },

  // Usuarios del sistema disponibles para vincular (no asignados a otro empleado)
  usuariosVinculables(empleadoId = null) {
    return db.prepare(`
      SELECT u.id, u.usuario, u.nombre, u.rol
      FROM users u
      WHERE u.activo = 1
        AND (u.id NOT IN (SELECT id_usuario FROM empleados WHERE id_usuario IS NOT NULL AND id != ?)
             OR ? IS NULL)
      ORDER BY u.nombre
    `).all(empleadoId || '', empleadoId)
  },

  dniEnUso(dni, excludeId = null) {
    if (!dni) return false
    if (excludeId) return !!db.prepare(`SELECT 1 FROM empleados WHERE dni = ? AND id != ?`).get(dni, excludeId)
    return !!db.prepare(`SELECT 1 FROM empleados WHERE dni = ?`).get(dni)
  },
}

module.exports = EmpleadosModel
