'use strict'
// ─────────────────────────────────────────────────────────────────
// compatibilidad.js — Actividades de las unidades y validación de
// compatibilidad chofer ↔ vehículo/máquina ↔ operación.
//
// Regla: un chofer solo puede operar unidades/operaciones cuya actividad
// coincida con su tipo_operacion habilitado. Si falta el dato (campo vacío),
// NO se bloquea (defaults permisivos) para no romper operaciones existentes.
// ─────────────────────────────────────────────────────────────────

// Etiquetas legibles de cada actividad/especialización
const ACTIVIDADES = {
  camion_viajes:       'Camión - Viajes (Ventas)',
  camion_contenedores: 'Camión - Alquiler de Contenedores',
  maquina_deposito:    'Máquina - Depósito',
  maquina_alquiler:    'Máquina - Alquiler',
}

// Subconjuntos para los selects de cada tipo de unidad
const ACTIVIDADES_CAMION  = ['camion_viajes', 'camion_contenedores']
const ACTIVIDADES_MAQUINA = ['maquina_deposito', 'maquina_alquiler']

const label = (clave) => ACTIVIDADES[clave] || clave || '—'

// Actividad requerida por una operación (op_encabezado). null = sin requisito.
function actividadDeOperacion(op) {
  if (!op) return null
  if (op.tipo_op === 'M' && op.modalidad === 'flete') return 'camion_viajes'
  if (op.tipo_op === 'C')  return 'camion_contenedores'
  if (op.tipo_op === 'MA') return 'maquina_alquiler'
  return null // venta en depósito u otros: no requiere chofer/unidad
}

// ¿El chofer puede tomar una operación con la unidad dada?
// Devuelve { ok, motivo }. Permisivo si faltan datos.
function validarAsignacionOperacion({ chofer, op, unidad }) {
  const req = actividadDeOperacion(op)
  if (!req) return { ok: true }
  if (chofer && chofer.tipo_operacion && chofer.tipo_operacion !== req) {
    const nom = `${chofer.nombre || ''} ${chofer.apellido || ''}`.trim()
    return { ok: false, motivo: `El chofer ${nom} está habilitado para "${label(chofer.tipo_operacion)}" y esta operación requiere "${label(req)}".` }
  }
  if (unidad && unidad.actividad && unidad.actividad !== req) {
    return { ok: false, motivo: `La unidad está destinada a "${label(unidad.actividad)}" y esta operación requiere "${label(req)}".` }
  }
  return { ok: true }
}

// ¿El chofer es compatible con la actividad de un recurso (camión/máquina)?
// Permisivo si falta cualquiera de los dos datos.
function validarAsignacionRecurso(choferTipo, recursoActividad, choferNombre = '') {
  if (!choferTipo || !recursoActividad) return { ok: true }
  if (choferTipo !== recursoActividad) {
    return { ok: false, motivo: `${choferNombre || 'El chofer'} está habilitado para "${label(choferTipo)}" y la unidad es para "${label(recursoActividad)}". Asignación incompatible.` }
  }
  return { ok: true }
}

module.exports = {
  ACTIVIDADES, ACTIVIDADES_CAMION, ACTIVIDADES_MAQUINA, label,
  actividadDeOperacion, validarAsignacionOperacion, validarAsignacionRecurso,
}
