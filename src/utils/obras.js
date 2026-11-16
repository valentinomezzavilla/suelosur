'use strict'

// Obras de un cliente, para filtrar reportes. Una operación pertenece a la obra que tenga
// cargada; si no tiene, su "obra" es la dirección (calle + número) de la entrega. En las
// ventas la dirección está en la cabecera; en los alquileres de contenedor y de maquinaria,
// en el detalle (cont_* / maq_*).
const limpiar = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim()
const direccion = (calle, numero) => limpiar([calle, numero].map(limpiar).filter(Boolean).join(' '))

// Algunas obras se cargaron con el prefijo "Obra" ("OBRA PRADOS..." y "PRADOS..." son la misma)
const sinPrefijo = (v) => limpiar(v).replace(/^obra\b[\s:.-]*/i, '')

function nombreObra(op = {}) {
  return sinPrefijo(op.obra)
    || direccion(op.domicilio_calle, op.domicilio_altura)
    || direccion(op.cont_calle, op.cont_numero) || limpiar(op.cont_entrega)
    || direccion(op.maq_calle, op.maq_numero) || limpiar(op.maq_entrega)
}

// Clave para agrupar: la misma obra cargada con otras mayúsculas, acentos o espacios
// es una sola entrada del listado.
function claveObra(nombre) {
  return limpiar(nombre).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
}

// ops: [{ id, ...campos de destino }], de la más reciente a la más vieja.
// Devuelve [{ clave, nombre, opIds }] ordenado por nombre; el nombre que se muestra es
// el de la operación más reciente.
function agruparObras(ops = []) {
  const grupos = new Map()
  for (const op of ops) {
    const nombre = nombreObra(op)
    if (!nombre) continue
    const clave = claveObra(nombre)
    if (!grupos.has(clave)) grupos.set(clave, { clave, nombre, opIds: [] })
    grupos.get(clave).opIds.push(String(op.id))
  }
  return [...grupos.values()].sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'))
}

// Obras elegidas en un filtro (parámetro "obra" de la URL, se puede repetir para elegir
// varias) → lista de claves sin vacíos ni repetidos. Acepta un texto, una lista o el objeto
// que arma el parser de la URL con muchos valores ({ 0: 'a', 1: 'b', ... }).
function clavesObra(valor) {
  const lista = Array.isArray(valor) ? valor
    : (valor && typeof valor === 'object' ? Object.values(valor) : [valor])
  return [...new Set(lista.filter(v => typeof v === 'string' || typeof v === 'number').map(limpiar).filter(Boolean))]
}

// Varias obras elegidas como una sola: [{ clave, nombre, opIds }] → { claves, nombres,
// nombre ('A, B'), etiqueta ('Obra' / 'Obras'), opIds (las de todas, sin repetir) }.
function unirObras(obras = []) {
  if (!obras.length) return null
  const nombres = obras.map(o => o.nombre)
  return {
    claves: obras.map(o => o.clave),
    nombres,
    nombre: nombres.join(', '),
    etiqueta: nombres.length > 1 ? 'Obras' : 'Obra',
    opIds: [...new Set(obras.flatMap(o => o.opIds.map(String)))],
  }
}

// Movimientos de cuenta corriente que entran en el estado de cuenta de una obra: los
// cargos de sus operaciones y todos los pagos del cliente (los pagos no están atados a
// una obra). También los créditos sueltos (ajustes a favor sin operación).
function movimientoDeObra(m, opIds) {
  if (m.id_op_encabezado != null && opIds.has(String(m.id_op_encabezado))) return true
  if (m.tipo === 'pago') return true
  return m.id_op_encabezado == null && Number(m.monto) > 0
}

module.exports = { nombreObra, claveObra, agruparObras, clavesObra, unirObras, movimientoDeObra }
