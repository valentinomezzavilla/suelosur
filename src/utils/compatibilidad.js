'use strict'
// ─────────────────────────────────────────────────────────────────
// compatibilidad.js — Actividades de las unidades y validación de
// compatibilidad chofer ↔ vehículo/máquina ↔ operación.
//
// Categorías unificadas (3): Ventas · Contenedores · Máquinas.
// Aplica a la actividad de camiones y máquinas, y a la especialización
// (tipo_operacion) del chofer.
//
// Regla: un chofer solo puede operar unidades/operaciones cuya actividad
// coincida con su tipo_operacion habilitado. Si falta el dato (campo vacío),
// NO se bloquea (defaults permisivos) para no romper operaciones existentes.
// ─────────────────────────────────────────────────────────────────

// Etiquetas legibles de cada categoría
const ACTIVIDADES = {
  ventas:       'Ventas (viajes)',
  contenedores: 'Contenedores',
  maquinas:     'Máquinas',
}

// Lista unificada para los selects de camión / máquina / chofer
const OPCIONES = ['ventas', 'contenedores', 'maquinas']
// Alias retro-compatibles (por si algún import viejo los usa)
const ACTIVIDADES_CAMION  = OPCIONES
const ACTIVIDADES_MAQUINA = OPCIONES

// Normaliza valores heredados del esquema anterior de 4 categorías
const _LEGACY = {
  camion_viajes: 'ventas',
  camion_contenedores: 'contenedores',
  maquina_deposito: 'maquinas',
  maquina_alquiler: 'maquinas',
}
function normalizar(clave) {
  if (!clave) return clave
  return _LEGACY[clave] || clave
}

const label = (clave) => ACTIVIDADES[normalizar(clave)] || clave || '—'

// Actividad requerida por una operación (op_encabezado). null = sin requisito.
function actividadDeOperacion(op) {
  if (!op) return null
  if (op.tipo_op === 'M' && op.modalidad === 'flete') return 'ventas'
  if (op.tipo_op === 'C')  return 'contenedores'
  if (op.tipo_op === 'MA') return 'maquinas'
  return null // venta en depósito u otros: no requiere chofer/unidad
}

// ¿El chofer puede tomar una operación con la unidad dada?
// Devuelve { ok, motivo }. Permisivo si faltan datos.
function validarAsignacionOperacion({ chofer, op, unidad }) {
  const req = actividadDeOperacion(op)
  if (!req) return { ok: true }
  const choferTipo = chofer && normalizar(chofer.tipo_operacion)
  const unidadAct  = unidad && normalizar(unidad.actividad)
  if (choferTipo && choferTipo !== req) {
    const nom = `${chofer.nombre || ''} ${chofer.apellido || ''}`.trim()
    return { ok: false, motivo: `El chofer ${nom} está habilitado para "${label(choferTipo)}" y esta operación requiere "${label(req)}".` }
  }
  if (unidadAct && unidadAct !== req) {
    return { ok: false, motivo: `La unidad está destinada a "${label(unidadAct)}" y esta operación requiere "${label(req)}".` }
  }
  return { ok: true }
}

// ¿El chofer es compatible con la actividad de un recurso (camión/máquina)?
// Permisivo si falta cualquiera de los dos datos.
function validarAsignacionRecurso(choferTipo, recursoActividad, choferNombre = '') {
  const ct = normalizar(choferTipo), ra = normalizar(recursoActividad)
  if (!ct || !ra) return { ok: true }
  if (ct !== ra) {
    return { ok: false, motivo: `${choferNombre || 'El chofer'} está habilitado para "${label(ct)}" y la unidad es para "${label(ra)}". Asignación incompatible.` }
  }
  return { ok: true }
}

module.exports = {
  ACTIVIDADES, OPCIONES, ACTIVIDADES_CAMION, ACTIVIDADES_MAQUINA, label, normalizar,
  actividadDeOperacion, validarAsignacionOperacion, validarAsignacionRecurso,
}
