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
//  · Sueldo: además del egreso queda el pago en la ficha del empleado (pagos_empleado,
//    con su recibo), igual que al cargar un sueldo desde Compras; se borra con el egreso.
//  · "Concepto / remito": texto libre para cualquier categoría (obligatorio en "Otro").
// ═══════════════════════════════════════════════════════════════════
const { query } = require('../config/db')
const CategoriasEgresoModel = require('../models/categoriasEgreso.model')

// Material mueve stock (cantidad, costo, flete): tiene su propio circuito en Compras
const EXCLUIDAS = ['material']
// Categorías del sistema sin campos configurables: los que usa el formulario de Compras
const CAMPOS_SISTEMA = { sueldo: ['empleado', 'periodo'] }
const camposDe = (cat) => CAMPOS_SISTEMA[cat.clave] || cat.campos
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
  for (const campo of camposDe(cat)) {
    const col = COLUMNA[campo]
    const v = col ? String(body['tercero_' + col] || '').trim() : ''
    if (v) t[col] = v
  }
  if (camposDe(cat).includes('proveedor') && !t.id_proveedor) throw new Error('Elegí el proveedor al que se le transfirió.')
  if (clave === 'sueldo' && !t.id_empleado) throw new Error('Elegí el empleado al que se le pagó el sueldo.')
  if (t.periodo && !/^\d{4}-\d{2}$/.test(t.periodo)) delete t.periodo
  const concepto = String(body.tercero_concepto || '').trim().slice(0, 200)
  if (clave === 'otro' && !concepto) throw new Error('Escribí el concepto / remito de la transferencia a tercero.')
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
  if (t.categoria === 'sueldo') return crearSueldo(t, { monto, fecha, descripcion, id_op_encabezado, id_transaccion, id_movimiento_cuenta, id_usuario }, q)
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

// Sueldo pagado por transferencia del cliente: el pago en la ficha del empleado (con su
// recibo) y el egreso de Sueldo atado a él, como PagosEmpleadoModel.registrar, pero dentro
// de la misma transacción del cobro (q) y con origen 'tercero' para borrarlo con el cobro.
async function crearSueldo(t, { monto, fecha, descripcion, id_op_encabezado, id_transaccion, id_movimiento_cuenta, id_usuario }, q) {
  const emp = (await q(`SELECT nombre, apellido FROM empleados WHERE id = ?`, [t.id_empleado])).rows[0]
  if (!emp) throw new Error('El empleado de la transferencia a tercero no existe.')
  const neto = Math.round((Number(monto) || 0) * 100) / 100
  const dia = fecha ? String(fecha).slice(0, 10) : null
  const detalle = [t.concepto, descripcion].filter(Boolean).join(' — ')
  const p = (await q(`
    INSERT INTO pagos_empleado (id_empleado, tipo, periodo, monto, sueldo_base, descuentos, adiciones, fecha, descripcion, metodo_pago, id_usuario)
    VALUES (?, 'sueldo', ?, ?, ?, 0, 0, COALESCE(?, to_char(CURRENT_DATE, 'YYYY-MM-DD')), ?, 'transferencia', ?)
    RETURNING id, fecha
  `, [t.id_empleado, t.periodo || null, neto, neto, dia, detalle, id_usuario || null])).rows[0]
  const nombre = `${emp.nombre} ${emp.apellido || ''}`.trim()
  const texto = [`Sueldo — ${nombre}`, t.periodo ? `(${t.periodo})` : '', detalle ? `— ${detalle}` : ''].filter(Boolean).join(' ')
  const e = (await q(`
    INSERT INTO egresos (fecha, categoria, descripcion, monto, metodo_pago, periodo, id_empleado, datos_extra, origen, id_usuario,
                         id_pago_empleado, id_op_encabezado, id_transaccion, id_movimiento_cuenta)
    VALUES (?, 'sueldo', ?, ?, 'transferencia', ?, ?, '{}', ?, ?, ?, ?, ?, ?)
    RETURNING id
  `, [p.fecha, texto, neto, t.periodo || null, t.id_empleado, ORIGEN, id_usuario || null, p.id,
      id_op_encabezado || null, id_transaccion || null, id_movimiento_cuenta || null])).rows[0]
  await q(`UPDATE pagos_empleado SET id_egreso = ? WHERE id = ?`, [e.id, p.id])
  return e.id
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

// Borra los egresos a tercero que cumplen `donde` (y el pago de sueldo que tengan atado)
async function borrar(donde, valor, q) {
  await q(`DELETE FROM pagos_empleado WHERE id IN (
             SELECT id_pago_empleado FROM egresos WHERE ${donde} = ? AND origen = ? AND id_pago_empleado IS NOT NULL)`, [valor, ORIGEN])
  await q(`DELETE FROM egresos WHERE ${donde} = ? AND origen = ?`, [valor, ORIGEN])
}
const borrarDeTransaccion = (idTransaccion, q = query) => borrar('id_transaccion', idTransaccion, q)
const borrarDeOp = (idOp, q = query) => borrar('id_op_encabezado', idOp, q)

// Opciones de los desplegables (mismas categorías y listas que el formulario de Compras)
async function opciones() {
  const ProveedoresModel = require('../models/proveedores.model')
  const EmpleadosModel = require('../models/empleados.model')
  const FlotaModel = require('../models/flota.model')
  const StockModel = require('../models/stock.model')
  const categorias = (await CategoriasEgresoModel.listar({ soloActivas: true }))
    .filter(c => !EXCLUIDAS.includes(c.clave))
    .map(c => ({ clave: c.clave, etiqueta: c.etiqueta, campos: camposDe(c).filter(k => COLUMNA[k]) }))
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
