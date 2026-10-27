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
const FleterosModel = require('../models/fleteros.model')

// Material mueve stock (cantidad, costo, flete): tiene su propio circuito en Compras
const EXCLUIDAS = ['material']
// Categorías del sistema sin campos configurables: los que usa el formulario de Compras
const CAMPOS_SISTEMA = { sueldo: ['empleado', 'periodo'] }
const camposDe = (cat) => CAMPOS_SISTEMA[cat.clave] || cat.campos
// Campo de la categoría → columna del egreso (mismos campos que el formulario de Compras)
// (Estación de servicio es un proveedor marcado como tal: también va en id_proveedor)
const COLUMNA = { proveedor: 'id_proveedor', estacion: 'id_proveedor', vehiculo: 'id_vehiculo', empleado: 'id_empleado', producto: 'id_producto', fletero: 'fletero', periodo: 'periodo' }
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
  if (camposDe(cat).includes('estacion')) {
    if (!t.id_proveedor) throw new Error('Elegí la estación de servicio a la que se le transfirió.')
    const est = (await query(`SELECT 1 FROM proveedores WHERE id = ? AND es_estacion = 1`, [t.id_proveedor])).rows[0]
    if (!est) throw new Error('La estación de servicio elegida no es válida.')
  }
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

// Un cobro (transacción) o pago de cuenta corriente genera UN solo egreso a tercero: si ya
// tiene uno, se devuelve ese en lugar de crear otro (no se duplica lo pagado al tercero ni
// se descuenta dos veces de la deuda con una estación).
async function egresoExistente({ id_transaccion, id_movimiento_cuenta }, q) {
  const [col, valor] = id_transaccion ? ['id_transaccion', id_transaccion] : (id_movimiento_cuenta ? ['id_movimiento_cuenta', id_movimiento_cuenta] : [])
  if (!col) return null
  return (await q(`SELECT id FROM egresos WHERE ${col} = ? AND origen = ? ORDER BY id LIMIT 1`, [valor, ORIGEN])).rows[0]?.id || null
}

async function crearEgreso(t, { monto, fecha, descripcion, id_op_encabezado, id_transaccion, id_movimiento_cuenta, id_usuario }, q = query) {
  const existente = await egresoExistente({ id_transaccion, id_movimiento_cuenta }, q)
  if (existente) return existente
  if (t.categoria === 'sueldo') return crearSueldo(t, { monto, fecha, descripcion, id_op_encabezado, id_transaccion, id_movimiento_cuenta, id_usuario }, q)
  const desc = [t.concepto, descripcion].filter(Boolean).join(' — ')
  const fletero = await FleterosModel.asegurar(t.fletero, q)
  const { rows } = await q(`
    INSERT INTO egresos (fecha, categoria, descripcion, monto, metodo_pago, fletero, periodo, id_proveedor, id_producto, id_empleado,
                         id_vehiculo, datos_extra, origen, id_usuario, id_op_encabezado, id_transaccion, id_movimiento_cuenta)
    VALUES (COALESCE(?, to_char(CURRENT_DATE, 'YYYY-MM-DD')), ?, ?, ?, 'transferencia', ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?, ?)
    RETURNING id
  `, [fecha ? String(fecha).slice(0, 10) : null, t.categoria, desc, Number(monto) || 0, fletero, t.periodo || null,
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

// A quién se le transfirió, para mostrarlo en el pago del cliente: la estación / proveedor,
// el empleado, o si no el concepto o la categoría.
async function destino(t, q = query) {
  if (t.id_proveedor) {
    const p = (await q(`SELECT nombre FROM proveedores WHERE id = ?`, [t.id_proveedor])).rows[0]
    if (p) return p.nombre
  }
  if (t.id_empleado) {
    const e = (await q(`SELECT nombre, apellido FROM empleados WHERE id = ?`, [t.id_empleado])).rows[0]
    if (e) return `${e.nombre} ${e.apellido || ''}`.trim()
  }
  if (t.concepto) return t.concepto
  const cat = await CategoriasEgresoModel.obtenerPorClave(t.categoria)
  return cat ? cat.etiqueta : 'tercero'
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
const borrarDeMovimiento = (idMov, q = query) => borrar('id_movimiento_cuenta', idMov, q)

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
    estaciones: (await ProveedoresModel.listar()).filter(p => p.es_estacion).map(p => ({ id: p.id, nombre: p.nombre })),
    empleados: (await EmpleadosModel.listar()).map(e => ({ id: e.id, nombre: `${e.nombre} ${e.apellido || ''}`.trim() })),
    vehiculos: (await FlotaModel.listar({})).map(v => ({ id: v.id, nombre: [v.numero_interno ? '#' + v.numero_interno : null, v.patente, v.nombre].filter(Boolean).join(' · ') })),
    productos: (await StockModel.listar()).map(p => ({ id: p.id, nombre: p.nombre })),
    fleteros: (await FleterosModel.listar()).map(f => f.nombre),
  }
}

module.exports = { leer, guardarEnOp, crearEgreso, destino, egresoDeCobro, borrarDeTransaccion, borrarDeOp, borrarDeMovimiento, opciones, parsear }
