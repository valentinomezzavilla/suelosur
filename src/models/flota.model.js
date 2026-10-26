'use strict'
// Flota de camiones — CRUD + estados operativos con historial.
const { query, transaction } = require('../config/db')

const CAMPOS = [
  'tipo_vehiculo', 'patente', 'nombre', 'numero_interno', 'marca', 'modelo', 'anio',
  'nro_chasis', 'nro_motor', 'tipo_unidad', 'capacidad_carga', 'kilometraje', 'estado_operativo',
  'dedicacion', 'actividad', 'fecha_ultimo_mant', 'fecha_proximo_mant', 'observaciones',
]
const NUMERICOS = new Set(['anio', 'capacidad_carga', 'kilometraje', 'numero_interno'])

// Datos que hay que completar para dar de alta un camión (el formulario los marca con *).
// Patente y nombre son NOT NULL en la tabla; tipo de unidad y actividad son los que usan
// las reglas de compatibilidad chofer ↔ camión ↔ operación (sin actividad no se validan).
const OBLIGATORIOS = {
  patente: 'Patente',
  nombre: 'Nombre / Identificación',
  tipo_unidad: 'Tipo de unidad',
  actividad: 'Actividad del camión',
}

// Etiquetas de los obligatorios que están vacíos (solo espacios cuenta como vacío).
function faltantes(datos) {
  return Object.entries(OBLIGATORIOS)
    .filter(([campo]) => !String(datos[campo] == null ? '' : datos[campo]).trim())
    .map(([, etiqueta]) => etiqueta)
}

// Dónde queda registrada la actividad de un camión. Si tiene alguna, eliminarlo borraría
// historial (operaciones, gastos, combustible…): en ese caso solo se puede dar de baja.
const USOS = [
  ['op_encabezado', 'id_camion', 'operaciones'],
  ['movimiento_contenedor', 'id_camion', 'movimientos de contenedores'],
  ['movimiento_maquinaria', 'id_camion', 'movimientos de maquinaria'],
  ['circuitos', 'id_camion', 'circuitos'],
  ['mantenimiento_vehiculo', 'id_vehiculo', 'mantenimientos'],
  ['combustible', 'id_vehiculo', 'cargas de combustible'],
  ['gastos_vehiculo', 'id_vehiculo', 'gastos'],
  ['egresos', 'id_vehiculo', 'compras / pagos'],
  ['historial_kilometraje', 'id_vehiculo', 'registros de kilometraje'],
]

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
  OBLIGATORIOS,
  faltantes,
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
      wheres.push('(v.nombre ILIKE ? OR v.patente ILIKE ? OR v.marca ILIKE ? OR v.modelo ILIKE ? OR CAST(v.numero_interno AS TEXT) ILIKE ?)')
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

  // Estado operativo automático según uso. NO toca estados manuales
  // (en_mantenimiento / fuera_servicio / inactivo): solo alterna
  // disponible ↔ en_viaje. Si no hay camión, no hace nada.
  async setEnUso(camionId, enUso) {
    if (!camionId) return
    if (enUso) {
      await query(`UPDATE flota_vehiculos SET estado_operativo = 'en_viaje' WHERE id = ? AND estado_operativo IN ('disponible','activo')`, [camionId])
    } else {
      await query(`UPDATE flota_vehiculos SET estado_operativo = 'disponible' WHERE id = ? AND estado_operativo = 'en_viaje'`, [camionId])
    }
  },

  // id_camion de una operación (para actualizar su estado por uso)
  async camionDeOperacion(opId) {
    const r = (await query(`SELECT id_camion FROM op_encabezado WHERE id = ?`, [opId])).rows[0]
    return r ? r.id_camion : null
  },

  // Suma automática de kilometraje al finalizar un viaje (ida + vuelta).
  // km_nuevo = km_actual + round(2 × distancia). Registra en el historial.
  async sumarKilometraje(idVehiculo, distanciaKm, idOp = null) {
    const dist = parseFloat(distanciaKm) || 0
    if (!idVehiculo || dist <= 0) return null
    const incremento = Math.round(dist * 2)
    return await transaction(async (q) => {
      const v = (await q(`SELECT kilometraje FROM flota_vehiculos WHERE id = ?`, [idVehiculo])).rows[0]
      if (!v) return null
      const kmAnterior = parseInt(v.kilometraje) || 0
      const kmNuevo = kmAnterior + incremento
      await q(`UPDATE flota_vehiculos SET kilometraje = ? WHERE id = ?`, [kmNuevo, idVehiculo])
      await q(`INSERT INTO historial_kilometraje (id_vehiculo, id_op, km_anterior, km_nuevo, distancia, motivo)
               VALUES (?, ?, ?, ?, ?, ?)`,
        [idVehiculo, idOp || null, kmAnterior, kmNuevo, dist, 'Viaje finalizado (ida + vuelta)'])
      return { kmAnterior, kmNuevo, incremento }
    })
  },

  async historialKm(idVehiculo) {
    return (await query(`SELECT * FROM historial_kilometraje WHERE id_vehiculo = ? ORDER BY fecha DESC, id DESC LIMIT 50`, [idVehiculo])).rows
  },

  // Ubicación del camión = última posición GPS del chofer asignado.
  // Nunca se carga manual. Devuelve estado: ok / sin_chofer / sin_ubicacion.
  async ubicacionActual(camionId) {
    const asig = (await query(
      `SELECT id_empleado FROM asignaciones_recurso WHERE recurso_tipo='camion' AND recurso_id = ? AND activo = 1 LIMIT 1`,
      [camionId])).rows[0]
    if (!asig) return { estado: 'sin_chofer' }
    const emp = (await query(`SELECT nombre, apellido FROM empleados WHERE id = ?`, [asig.id_empleado])).rows[0]
    const chofer = emp ? `${emp.nombre} ${emp.apellido || ''}`.trim() : null
    const pos = (await query(
      `SELECT lat, lng, fecha_registro FROM rastreo_chofer WHERE id_empleado = ? ORDER BY fecha_registro DESC LIMIT 1`,
      [asig.id_empleado])).rows[0]
    if (!pos || pos.lat == null) return { estado: 'sin_ubicacion', chofer }
    return { estado: 'ok', lat: pos.lat, lng: pos.lng, fecha: pos.fecha_registro, chofer }
  },

  // Validaciones de unicidad
  async patenteEnUso(patente, excludeId = null) {
    if (!patente) return false
    if (excludeId) return !!(await query(`SELECT 1 FROM flota_vehiculos WHERE patente = ? AND id != ?`, [patente, excludeId])).rows[0]
    return !!(await query(`SELECT 1 FROM flota_vehiculos WHERE patente = ?`, [patente])).rows[0]
  },
  async numeroInternoEnUso(numero, excludeId = null) {
    if (!numero) return false
    if (excludeId) return !!(await query(`SELECT 1 FROM flota_vehiculos WHERE numero_interno = ? AND id != ?`, [numero, excludeId])).rows[0]
    return !!(await query(`SELECT 1 FROM flota_vehiculos WHERE numero_interno = ?`, [numero])).rows[0]
  },

  async crear(datos) {
    const sinCompletar = faltantes(datos)
    if (sinCompletar.length) throw new Error(`Completá los datos obligatorios: ${sinCompletar.join(', ')}.`)
    const d = normalizar(datos)
    if (await this.patenteEnUso(d.patente)) throw new Error(`Ya existe un camión con la patente ${d.patente}.`)
    if (await this.numeroInternoEnUso(d.numero_interno)) throw new Error(`Ya existe un camión con el número interno ${d.numero_interno}.`)
    const cols = [...CAMPOS]
    const { rows } = await query(`INSERT INTO flota_vehiculos (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')}) RETURNING id`,
      [...CAMPOS.map(c => d[c])])
    const id = rows[0].id
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

  // Elimina un camión que no tiene actividad registrada (ej. uno cargado por error). Con
  // actividad no se borra: se informa qué tiene y se sugiere darlo de baja. Junto con el
  // camión se borran sus datos propios (historial de estados, reglas de mantenimiento,
  // asignación a un chofer y documentos). Devuelve los archivos de documentos a borrar del disco.
  async eliminar(id) {
    return transaction(async (q) => {
      const v = (await q(`SELECT id FROM flota_vehiculos WHERE id = ?`, [id])).rows[0]
      if (!v) throw new Error('Camión no encontrado.')
      const usos = []
      for (const [tabla, columna, etiqueta] of USOS) {
        const n = Number((await q(`SELECT COUNT(*) AS n FROM ${tabla} WHERE ${columna} = ?`, [id])).rows[0].n)
        if (n) usos.push(`${n} ${etiqueta}`)
      }
      if (usos.length) throw new Error(`No se puede eliminar el camión: tiene ${usos.join(', ')}. Para conservar el historial, dalo de baja.`)
      const archivos = (await q(`SELECT archivo FROM documentos WHERE entidad_tipo = 'vehiculo' AND entidad_id = ? AND archivo IS NOT NULL`, [id])).rows.map(r => r.archivo)
      await q(`DELETE FROM documentos WHERE entidad_tipo = 'vehiculo' AND entidad_id = ?`, [id])
      await q(`DELETE FROM asignaciones_recurso WHERE recurso_tipo = 'camion' AND recurso_id = ?`, [id])
      await q(`DELETE FROM config_mantenimiento WHERE id_vehiculo = ?`, [id])
      await q(`DELETE FROM estado_vehiculo_hist WHERE id_vehiculo = ?`, [id])
      await q(`DELETE FROM flota_vehiculos WHERE id = ?`, [id])
      return { archivos }
    })
  },

  async toggleActivo(id) {
    await query(`UPDATE flota_vehiculos SET activo = 1 - activo WHERE id = ?`, [id])
  },

  async registrarEstado(id, estado, usuarioId, obs) {
    await query(`INSERT INTO estado_vehiculo_hist (id_vehiculo, estado, id_usuario, observaciones) VALUES (?, ?, ?, ?)`,
      [id, estado, usuarioId || null, obs || ''])
  },

  async cambiarEstado(id, estado, usuarioId, obs) {
    if (!ESTADOS.includes(estado)) throw new Error('Estado inválido.')
    await transaction(async (q) => {
      await q(`UPDATE flota_vehiculos SET estado_operativo = ? WHERE id = ?`, [estado, id])
      await q(`INSERT INTO estado_vehiculo_hist (id_vehiculo, estado, id_usuario, observaciones) VALUES (?, ?, ?, ?)`,
        [id, estado, usuarioId || null, obs || ''])
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
