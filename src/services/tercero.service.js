'use strict'
// ═══════════════════════════════════════════════════════════════════
// Transferencia "destinada a tercero": el cliente paga por transferencia, pero
// directo a un tercero (un proveedor nuestro, un taller, un seguro…). El cobro se
// registra igual que siempre y además se crea el egreso en Compras / Pagos por el
// mismo monto, con la categoría y el destinatario elegidos (o "Otro" + concepto).
//
//  · Operaciones (ventas / alquileres): los datos del tercero se guardan en
//    op_encabezado.tercero (JSON) al elegir el método; el egreso se genera cuando se
//    registra el cobro por transferencia — TransaccionesModel.crear llama a
//    egresoDeCobro —, así cubre todos los caminos (cantera, viaje al entregar,
//    alquiler al retirar, cobro de grupo…). Si la transacción se borra o deja de ser
//    transferencia, el egreso se borra con ella (egresos.id_transaccion).
//  · Pagos de cuenta corriente: el egreso se crea en el momento, atado al
//    movimiento (egresos.id_movimiento_cuenta).
// ═══════════════════════════════════════════════════════════════════
const { query } = require('../config/db')
const CategoriasEgresoModel = require('../models/categoriasEgreso.model')

// Material mueve stock y Sueldo genera recibo: tienen su propio circuito en Compras
const EXCLUIDAS = ['material', 'sueldo']
// Campo de la categoría → columna del egreso (mismos campos que el formulario de Compras)
const COLUMNA = { proveedor: 'id_proveedor', vehiculo: 'id_vehiculo', empleado: 'id_empleado', producto: 'id_producto', fletero: 'fletero', periodo: 'periodo' }
const ORIGEN = 'tercero'

const marcado = (v) => v === '1' || v === 'on' || v === true
const ref = (op) => op.nro_remito ? `Remito ${op.nro_remito}` : `OP-${String(op.nro_op).padStart(4, '0')}`

function parsear(json) {
  if (!json) return null
  try { const t = typeof json === 'string' ? JSON.parse(json) : json; return t && t.categoria ? t : null } catch (_) { return null }
}

// Lee y valida el tercero que viene del formulario (campos tercero_*). Devuelve null si
// no corresponde: el método no es transferencia o no se marcó "Destinado a tercero".
// Tira un Error con un mensaje para el usuario si está incompleto.
async function leer(body = {}, metodo) {
  if (metodo !== 'transferencia' || !marcado(body.tercero)) return null
  const clave = String(body.tercero_categoria || '').trim()
  if (!clave) throw new Error('Elegí a qué se destinó la transferencia al tercero.')
  const cat = EXCLUIDAS.includes(clave) ? null : await CategoriasEgresoModel.obtenerPorClave(clave)
  if (!cat || !cat.activo) throw new Error('La categoría elegida para la transferencia a tercero no es válida.')
  const t = { categoria: clave }
  for (const campo of cat.campos) {
    const col = COLUMNA[campo]
    const v = col ? String(body['tercero_' + col] || '').trim() : ''
    if (v) t[col] = v
  }
  if (cat.campos.includes('proveedor') && !t.id_proveedor) throw new Error('Elegí el proveedor al que se le transfirió.')
  const concepto = String(body.tercero_concepto || '').trim()
  if (clave === 'otro' && !concepto) throw new Error('Escribí el concepto de la transferencia a tercero.')
  if (concepto) t.concepto = concepto
  return t
}

// Guarda (o borra, con tercero = null) los datos del tercero en una operación. Con
// grupo: true, también en el resto de su alquiler agrupado (el cobro es uno solo).
async function guardarEnOp(id, tercero, { grupo = false } = {}, q = query) {
  const json = tercero ? JSON.stringify(tercero) : null
  if (grupo) {
    await q(`UPDATE op_encabezado SET tercero = ?
             WHERE id = ? OR (id_grupo IS NOT NULL AND id_grupo = (SELECT id_grupo FROM op_encabezado WHERE id = ?))`, [json, id, id])
  } else {
    await q(`UPDATE op_encabezado SET tercero = ? WHERE id = ?`, [json, id])
  }
}

async function crearEgreso(t, { monto, fecha, descripcion, id_op_encabezado, id_transaccion, id_movimiento_cuenta, id_usuario }, q = query) {
  const desc = [t.concepto, descripcion].filter(Boolean).join(' — ')
  const { rows } = await q(`
    INSERT INTO egresos (fecha, categoria, descripcion, monto, metodo_pago, fletero, periodo, id_proveedor, id_producto, id_empleado,
                         id_vehiculo, datos_extra, origen, id_usuario, id_op_encabezado, id_transaccion, id_movimiento_cuenta)
    VALUES (COALESCE(?, to_char(CURRENT_DATE, 'YYYY-MM-DD')), ?, ?, ?, 'transferencia', ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?, ?)
    RETURNING id
  `, [fecha ? String(fecha).slice(0, 10) : null, t.categoria, desc, Number(monto) || 0, t.fletero || null, t.periodo || null,
      t.id_proveedor || null, t.id_producto || null, t.id_empleado || null, t.id_vehiculo || null,
      ORIGEN, id_usuario || null, id_op_encabezado || null, id_transaccion || null, id_movimiento_cuenta || null])
  return rows[0].id
}

// Egreso del cobro de una operación que tiene tercero. Lo llama TransaccionesModel.crear
// cuando la transacción es por transferencia; no hace nada si la operación no tiene tercero.
async function egresoDeCobro({ id_transaccion, id_op_encabezado, monto, fecha, cliente, tipo }, q = query) {
  if (!id_op_encabezado || !(Number(monto) > 0)) return null
  const op = (await q(`SELECT tercero, nro_op, nro_remito FROM op_encabezado WHERE id = ?`, [id_op_encabezado])).rows[0]
  const t = parsear(op?.tercero)
  if (!t) return null
  return crearEgreso(t, {
    monto, fecha, id_op_encabezado, id_transaccion,
    descripcion: `Transferencia de ${cliente || 'cliente'} a tercero (${tipo} ${ref(op)})`,
  }, q)
}

async function borrarDeTransaccion(idTransaccion, q = query) {
  await q(`DELETE FROM egresos WHERE id_transaccion = ? AND origen = ?`, [idTransaccion, ORIGEN])
}

async function borrarDeOp(idOp, q = query) {
  await q(`DELETE FROM egresos WHERE id_op_encabezado = ? AND origen = ?`, [idOp, ORIGEN])
}

// Opciones de los desplegables (mismas categorías y listas que el formulario de Compras)
async function opciones() {
  const ProveedoresModel = require('../models/proveedores.model')
  const EmpleadosModel = require('../models/empleados.model')
  const FlotaModel = require('../models/flota.model')
  const StockModel = require('../models/stock.model')
  const categorias = (await CategoriasEgresoModel.listar({ soloActivas: true }))
    .filter(c => !EXCLUIDAS.includes(c.clave))
    .map(c => ({ clave: c.clave, etiqueta: c.etiqueta, campos: c.campos.filter(k => COLUMNA[k]) }))
  // "Otro" (concepto libre) siempre al final
  categorias.sort((a, b) => (a.clave === 'otro') - (b.clave === 'otro'))
  return {
    categorias,
    proveedores: (await ProveedoresModel.listar()).map(p => ({ id: p.id, nombre: p.nombre + (p.cuit ? ` (${p.cuit})` : '') })),
    empleados: (await EmpleadosModel.listar()).map(e => ({ id: e.id, nombre: `${e.nombre} ${e.apellido || ''}`.trim() })),
    vehiculos: (await FlotaModel.listar({})).map(v => ({ id: v.id, nombre: [v.numero_interno ? '#' + v.numero_interno : null, v.patente, v.nombre].filter(Boolean).join(' · ') })),
    productos: (await StockModel.listar()).map(p => ({ id: p.id, nombre: p.nombre })),
  }
}

module.exports = { leer, guardarEnOp, crearEgreso, egresoDeCobro, borrarDeTransaccion, borrarDeOp, opciones, parsear }
