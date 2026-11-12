'use strict'
// ═══════════════════════════════════════════════════════════════════
// movimientosDinero.model.js — Todo el movimiento de plata en un solo listado
// (pantalla Transacciones). Junta, sin copiar datos, tres fuentes que ya existen:
//
//   · transacciones       → cobros de ventas y alquileres (y ajustes). Una venta a cuenta
//                           corriente también está acá, pero no es plata que entró: se
//                           marca "a cuenta" y no suma a las entradas.
//   · movimientos_cuenta  → pagos de clientes a su cuenta corriente (tipo 'pago', no anulados).
//   · egresos             → lo que sale: sueldos, compras, combustible, etc. (Compras / Pagos).
//
// Cada fila trae su "categoría" (los botones de filtro), su sentido (entrada / salida /
// a cuenta), la fecha de pago y el día en que se cargó.
// ═══════════════════════════════════════════════════════════════════
const { query } = require('../config/db')
const TransaccionesModel = require('./transacciones.model')
const { SQL_DESCRIPCION_DETALLE } = require('../utils/contenedor')

// Botones de filtro, en el orden en que se muestran
const CATEGORIAS = [
  { clave: 'todas',          etiqueta: 'Todas' },
  { clave: 'ventas',         etiqueta: 'Ventas' },
  { clave: 'alquileres',     etiqueta: 'Alquileres' },
  { clave: 'pagos_clientes', etiqueta: 'Pagos de clientes' },
  { clave: 'sueldos',        etiqueta: 'Sueldos' },
  { clave: 'compras',        etiqueta: 'Compras y gastos' },
  { clave: 'ajustes',        etiqueta: 'Ajustes' },
]
const CLAVES = CATEGORIAS.map(c => c.clave)

// Métodos que no son plata cobrada en el momento: la venta queda "a cuenta"
const SIN_COBRO = ['cuenta_corriente', 'saldo_a_favor']

const SQL_UNION = `
  SELECT 'transaccion'::text AS origen, t.id,
         CASE WHEN t.tipo IN ('Venta Cantera', 'Venta Viaje') THEN 'ventas'
              WHEN t.tipo IN ('Alquiler', 'Maquinaria') THEN 'alquileres'
              ELSE 'ajustes' END AS categoria,
         t.tipo, t.numero, t.fecha, t.created_at AS cargado_en,
         t.cliente_id, t.cliente AS persona, t.descripcion, t.metodo_pago,
         ABS(t.monto)::float8 AS monto,
         CASE WHEN t.metodo_pago IN ('cuenta_corriente', 'saldo_a_favor') THEN 'a_cuenta'
              WHEN t.monto < 0 THEN 'salida' ELSE 'entrada' END AS sentido,
         t.id_op_encabezado, t.nro_remito,
         (oe.archivo_remito IS NOT NULL AND oe.archivo_remito <> '') AS tiene_remito_firmado,
         FALSE AS es_tercero, NULL::bigint AS id_pago_empleado, NULL::bigint AS id_empleado, NULL::text AS categoria_egreso
  FROM transacciones t
  LEFT JOIN op_encabezado oe ON oe.id = t.id_op_encabezado

  UNION ALL

  SELECT 'pago_cliente', m.id, 'pagos_clientes', 'Pago de cliente', NULL::int, m.created_at, m.registrado_en,
         m.cliente_id, TRIM(COALESCE(c.nombre, '') || ' ' || COALESCE(c.apellido, '')), m.descripcion, m.metodo_pago,
         ABS(m.monto)::float8, 'entrada',
         NULL::bigint, NULL::int, FALSE, FALSE, NULL::bigint, NULL::bigint, NULL::text
  FROM movimientos_cuenta m
  JOIN clientes c ON c.id = m.cliente_id
  WHERE m.tipo = 'pago' AND COALESCE(m.anulado, 0) = 0 AND m.monto > 0

  UNION ALL

  SELECT 'egreso', e.id, CASE WHEN e.categoria = 'sueldo' THEN 'sueldos' ELSE 'compras' END,
         COALESCE(ce.etiqueta, e.categoria), NULL::int, e.fecha, e.created_at,
         NULL::bigint,
         COALESCE(NULLIF(TRIM(COALESCE(em.nombre, '') || ' ' || COALESCE(em.apellido, '')), ''), p.nombre, NULLIF(e.fletero, ''), ''),
         e.descripcion, e.metodo_pago, ABS(e.monto)::float8, 'salida',
         e.id_op_encabezado, NULL::int, FALSE, (e.origen = 'tercero'), e.id_pago_empleado, e.id_empleado, e.categoria
  FROM egresos e
  LEFT JOIN categorias_egreso ce ON ce.clave = e.categoria
  LEFT JOIN empleados em ON em.id = e.id_empleado
  LEFT JOIN proveedores p ON p.id = e.id_proveedor
`

// N° de operación escrito a mano → número (misma regla que TransaccionesModel)
const nroOpDeTexto = (t) => TransaccionesModel.nroOpDeTexto(t)

// Código escrito a mano → qué fila es. Entiende lo que muestra la tabla: PAG-001240 (pago de un
// cliente), EGR-000123 (egreso), CAN-000045 / VIA / CON / MAQ / AJU (transacciones, por su N° de
// cada tipo); en cualquier mayúscula, con guion, espacio o sin nada ("pag 1240", "PAG1240").
// Solo dígitos ("1240"): cualquier fila cuyo N° sea ese. Algo que no se entiende → null.
// `estricto`: solo con prefijo conocido (para usarlo en la caja de nombres sin pisar un nombre).
const TIPO_POR_PREFIJO = Object.fromEntries(Object.entries(TransaccionesModel.PREFIJO).map(([tipo, pre]) => [pre, tipo]))
function codigoDeTexto(texto, { estricto = false } = {}) {
  const t = String(texto ?? '').trim()
  const m = /^([A-Za-z]{3})[\s-]*(\d+)$/.exec(t)
  if (m) {
    const pre = m[1].toUpperCase(), n = Number(m[2])
    if (pre === 'PAG') return { origen: 'pago_cliente', id: n }
    if (pre === 'EGR') return { origen: 'egreso', id: n }
    if (TIPO_POR_PREFIJO[pre]) return { origen: 'transaccion', tipo: TIPO_POR_PREFIJO[pre], numero: n }
    return null
  }
  if (!estricto && /^\d+$/.test(t)) return { cualquiera: Number(t) }
  return null
}

// Condición SQL (sobre la unión u) de un código ya entendido, o FALSE si no se entendió
function condicionCodigo(c) {
  if (!c) return { sql: 'FALSE', params: [] }
  if (c.origen === 'pago_cliente' || c.origen === 'egreso') return { sql: `u.origen = '${c.origen}' AND u.id = ?`, params: [c.id] }
  if (c.origen === 'transaccion') return { sql: `u.origen = 'transaccion' AND u.tipo = ? AND u.numero = ?`, params: [c.tipo, c.numero] }
  return { sql: `((u.origen IN ('pago_cliente', 'egreso') AND u.id = ?) OR (u.origen = 'transaccion' AND u.numero = ?))`, params: [c.cualquiera, c.cualquiera] }
}

// WHERE sobre la unión (alias u). `categoria` es el botón elegido; el resto, los filtros de
// siempre. Remito e id son solo de cobros (transacciones): con ellos las demás fuentes quedan afuera.
function filtro({ categoria, tipo, id, codigo, clienteId, cliente, remito, nroOp, fechaDesde, fechaHasta, montoMin, montoMax } = {}, { sinCategoria = false } = {}) {
  const w = []
  const p = []
  if (!sinCategoria && categoria && categoria !== 'todas' && CLAVES.includes(categoria)) { w.push('u.categoria = ?'); p.push(categoria) }
  // Tipo puntual de transacción (enlaces viejos: ?tipo=Venta Cantera)
  if (tipo && tipo !== 'todos') { w.push(`u.origen = 'transaccion' AND u.tipo = ?`); p.push(tipo) }
  if (id) { w.push(`u.origen = 'transaccion' AND u.id = ?`); p.push(Number(id) || 0) }
  if (codigo && String(codigo).trim()) { const c = condicionCodigo(codigoDeTexto(codigo)); w.push(c.sql); p.push(...c.params) }
  if (clienteId) { w.push('u.cliente_id = ?'); p.push(clienteId) }
  const texto = String(cliente || '').trim()
  // Si en la caja de nombres se escribe un código (PAG-001240), se busca ese código
  const codigoEnNombre = texto ? codigoDeTexto(texto, { estricto: true }) : null
  if (codigoEnNombre) { const c = condicionCodigo(codigoEnNombre); w.push(c.sql); p.push(...c.params) }
  else if (texto) { w.push('u.persona ILIKE ?'); p.push(`%${texto}%`) }
  if (remito && String(remito).trim()) { w.push(`u.origen = 'transaccion' AND u.nro_remito = ?`); p.push(Number(remito) || 0) }
  const nro = nroOpDeTexto(nroOp)
  if (nro != null) { w.push('u.id_op_encabezado IN (SELECT id FROM op_encabezado WHERE nro_op = ?)'); p.push(nro) }
  if (fechaDesde) { w.push('LEFT(u.fecha, 10) >= ?'); p.push(fechaDesde) }
  if (fechaHasta) { w.push('LEFT(u.fecha, 10) <= ?'); p.push(fechaHasta) }
  if (montoMin)   { w.push('u.monto >= ?'); p.push(Number(montoMin)) }
  if (montoMax)   { w.push('u.monto <= ?'); p.push(Number(montoMax)) }
  return { where: w.length ? 'WHERE ' + w.join(' AND ') : '', params: p }
}

const ORDEN = { fecha: 'u.fecha', monto: 'u.monto', tipo: 'u.tipo', created_at: 'u.cargado_en', cargado_en: 'u.cargado_en' }
function orden(sortBy, sortDir) {
  const col = ORDEN[sortBy] || 'u.fecha'
  const dir = sortDir === 'ASC' ? 'ASC' : 'DESC'
  return `${col} ${dir} NULLS LAST, u.cargado_en ${dir} NULLS LAST, u.id ${dir}`
}

// Código legible: el de la transacción (CAN-000001…), PAG-000123 o EGR-000123
function codigo(r) {
  if (!r) return ''
  if (r.origen === 'transaccion') return TransaccionesModel.codigo(r)
  return `${r.origen === 'pago_cliente' ? 'PAG' : 'EGR'}-${String(r.id).padStart(6, '0')}`
}

// Totales: entró, salió, neto, y lo vendido a cuenta (no es plata)
function totalesDe(filas) {
  const r2 = (n) => Math.round(n * 100) / 100
  let entradas = 0, salidas = 0, aCuenta = 0
  for (const f of filas) {
    const m = Number(f.monto) || 0
    if (f.sentido === 'entrada') entradas += m
    else if (f.sentido === 'salida') salidas += m
    else aCuenta += m
  }
  return { entradas: r2(entradas), salidas: r2(salidas), neto: r2(entradas - salidas), aCuenta: r2(aCuenta) }
}

const MovimientosDineroModel = {
  CATEGORIAS, CLAVES, SIN_COBRO,
  codigo, codigoDeTexto, totalesDe, _filtro: filtro, _orden: orden,

  async listar({ page = 1, limit = 20, sortBy = 'fecha', sortDir = 'DESC', ...filtros } = {}) {
    const { where, params } = filtro(filtros)
    const base = `FROM (${SQL_UNION}) u ${where}`
    const total = Number((await query(`SELECT COUNT(*) AS n ${base}`, params)).rows[0]?.n) || 0
    const rows = (await query(`SELECT u.* ${base} ORDER BY ${orden(sortBy, sortDir)} LIMIT ? OFFSET ?`,
      [...params, limit, (page - 1) * limit])).rows
    await TransaccionesModel._marcarSaldadas(rows.filter(r => r.origen === 'transaccion'))
    return { rows, total, page, limit, totalPaginas: Math.ceil(total / limit) }
  },

  // Todo lo filtrado, sin paginar (reporte)
  async todos({ sortBy = 'fecha', sortDir = 'ASC', ...filtros } = {}) {
    const { where, params } = filtro(filtros)
    const rows = (await query(`SELECT u.* FROM (${SQL_UNION}) u ${where} ORDER BY ${orden(sortBy, sortDir)}`, params)).rows
    await TransaccionesModel._marcarSaldadas(rows.filter(r => r.origen === 'transaccion'))
    return rows
  },

  // Totales de lo filtrado + cantidad por botón (con los mismos filtros, sin el del botón)
  async resumen(filtros = {}) {
    const { where, params } = filtro(filtros)
    const porSentido = (await query(
      `SELECT u.sentido, COALESCE(SUM(u.monto), 0)::float8 AS monto, COUNT(*)::int AS n FROM (${SQL_UNION}) u ${where} GROUP BY u.sentido`, params)).rows
    const filas = porSentido.map(r => ({ sentido: r.sentido, monto: r.monto }))
    const totales = totalesDe(filas)
    totales.cantidad = porSentido.reduce((s, r) => s + r.n, 0)

    const sinCat = filtro(filtros, { sinCategoria: true })
    const porCat = (await query(
      `SELECT u.categoria, COUNT(*)::int AS n FROM (${SQL_UNION}) u ${sinCat.where} GROUP BY u.categoria`, sinCat.params)).rows
    const conteo = Object.fromEntries(CLAVES.map(k => [k, 0]))
    porCat.forEach(r => { conteo[r.categoria] = r.n; conteo.todas += r.n })
    return { ...totales, conteo }
  },

  // Datos de la operación para el reporte (qué se vendió, obra, observaciones), por id de OP
  async detalleOperaciones(opIds) {
    const ids = [...new Set((opIds || []).filter(Boolean).map(Number))]
    if (!ids.length) return {}
    const rows = (await query(`
      SELECT oe.id, oe.nro_op, oe.obra, oe.observaciones AS obs_operacion,
             (SELECT STRING_AGG(${SQL_DESCRIPCION_DETALLE} || ' x' || CAST(d.cantidad_pedida AS TEXT), ', ')
                FROM op_detalle_material d JOIN productos p ON p.id = d.id_producto WHERE d.id_orden_pedido = oe.id) AS productos_str,
             (SELECT cont.numero_contenedor FROM op_detalle_contenedor oc LEFT JOIN contenedores cont ON cont.id = oc.id_contenedor
                WHERE oc.id_orden_pedido = oe.id ORDER BY oc.id LIMIT 1) AS numero_contenedor,
             (SELECT maq.nombre FROM op_detalle_maquinaria dm LEFT JOIN maquinaria maq ON maq.id = dm.id_maquinaria
                WHERE dm.id_orden_pedido = oe.id ORDER BY dm.id LIMIT 1) AS maquinaria_nombre
      FROM op_encabezado oe WHERE oe.id = ANY(?::bigint[])
    `, [ids])).rows
    return Object.fromEntries(rows.map(r => [r.id, r]))
  },
}

module.exports = MovimientosDineroModel
