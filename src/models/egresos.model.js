'use strict'
// ═══════════════════════════════════════════════════════════════════
// egresos.model.js — Libro único de salidas de dinero (compras / pagos).
// Cada fila es un egreso categorizado (material, sueldo, seguro, etc.),
// vinculado opcionalmente a un proveedor / empleado / vehículo.
// ═══════════════════════════════════════════════════════════════════
const { query, transaction } = require('../config/db')
const FleterosModel = require('./fleteros.model')
const CombustibleModel = require('./combustible.model')

// La transferencia de un cliente destinada a un tercero nace del cobro: se corrige o se borra ahí
const NO_EDITAR_TERCERO = 'Esta salida es la transferencia de un cliente destinada a un tercero: se corrige desde la transacción del cobro.'

// Stock de una compra de material: alta, edición y baja lo mueven con lo mismo, dentro de
// la transacción de la operación.
async function moverStock(q, id_producto, cantidad) {
  await q(`UPDATE stock SET cantidad_actual = cantidad_actual + ? WHERE id_producto = ?`, [cantidad, id_producto])
}
// Si algún stock quedó negativo (parte de lo que entró con la compra ya salió), se corta
// todo: el error deshace la transacción entera.
async function verificarStock(q, productos, accion) {
  const negativo = (await q(`
    SELECT p.nombre, s.cantidad_actual FROM stock s JOIN productos p ON p.id = s.id_producto
    WHERE s.id_producto = ANY(?::bigint[]) AND s.cantidad_actual < -0.0001
    LIMIT 1
  `, [productos])).rows[0]
  if (negativo) {
    throw new Error(`${accion}, el stock de ${negativo.nombre} quedaría en ${Math.round(Number(negativo.cantidad_actual) * 100) / 100} ` +
      `(parte de lo que entró con esta compra ya salió). Revisá el stock antes.`)
  }
}

// Filtros que se pueden combinar libremente desde el libro de compras / pagos.
// Las categorías son dinámicas (tabla categorias_egreso), acá no se validan.
// `periodo` filtra por el período propio del egreso, o el del pago de sueldo
// asociado cuando la categoría es 'sueldo' (join a pagos_empleado).
function construirFiltro({ id, categoria, id_proveedor, id_producto, id_empleado, id_vehiculo, metodo_pago, fletero, descripcion, periodo, fechaDesde, fechaHasta } = {}) {
  const wheres = []
  const params = []
  if (id)           { wheres.push('e.id = ?');                         params.push(id) }
  if (categoria)    { wheres.push('e.categoria = ?');                  params.push(categoria) }
  if (id_proveedor) { wheres.push('e.id_proveedor = ?');               params.push(id_proveedor) }
  if (id_producto)  { wheres.push('e.id_producto = ?');                params.push(id_producto) }
  if (id_empleado)  { wheres.push('e.id_empleado = ?');                params.push(id_empleado) }
  if (id_vehiculo)  { wheres.push('e.id_vehiculo = ?');                params.push(id_vehiculo) }
  if (metodo_pago)  { wheres.push('e.metodo_pago = ?');                params.push(metodo_pago) }
  if (fletero)      { wheres.push('e.fletero = ?');                    params.push(fletero) }
  if (descripcion)  { wheres.push('e.descripcion ILIKE ?');            params.push(`%${descripcion}%`) }
  if (periodo)      { wheres.push('COALESCE(e.periodo, pe.periodo) = ?'); params.push(periodo) }
  if (fechaDesde)   { wheres.push('e.fecha >= ?');                     params.push(fechaDesde) }
  if (fechaHasta)   { wheres.push('e.fecha <= ?');                     params.push(fechaHasta) }
  return { where: wheres.length ? 'WHERE ' + wheres.join(' AND ') : '', params }
}

const EgresosModel = {

  // `cantidad`, `subtotal_material`, `costo_final_flete` e `id_stock_ingreso` son solo de las
  // compras de material: guardan el detalle de lo que se compró (ver migrarDetalleCompras).
  // `hora`, `nro_factura`, `nro_remito`, `litros`, `id_chofer` e `id_combustible` son de los
  // pagos de combustible (categorías con el campo 'carga'); id_combustible es la carga que el
  // pago creó en Flota. `q`: la transacción de quien llama (para crear pago y carga juntos).
  async crear({ fecha, categoria, descripcion, monto, metodo_pago, fletero, periodo, id_proveedor, id_producto, id_empleado, id_vehiculo, datos_extra, origen, id_usuario,
                cantidad, subtotal_material, costo_final_flete, id_stock_ingreso,
                hora, nro_factura, nro_remito, litros, id_chofer, id_combustible }, q = null) {
    if (!categoria) throw new Error('Elegí una categoría válida.')
    // El fletero escrito queda dado de alta en Fleteros (o toma el nombre como está guardado)
    fletero = await FleterosModel.asegurar(fletero, q || query)
    const litrosNum = parseFloat(litros)
    const { rows } = await (q || query)(`
      INSERT INTO egresos (fecha, categoria, descripcion, monto, metodo_pago, fletero, periodo, id_proveedor, id_producto, id_empleado, id_vehiculo, datos_extra, origen, id_usuario,
                           cantidad, subtotal_material, costo_final_flete, id_stock_ingreso,
                           hora, nro_factura, nro_remito, litros, id_chofer, id_combustible)
      VALUES (COALESCE(?, to_char(CURRENT_DATE, 'YYYY-MM-DD')), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING id
    `, [fecha || null, categoria, descripcion || '', parseFloat(monto) || 0, metodo_pago || null, fletero,
        (periodo || '').trim() || null, id_proveedor || null, id_producto || null, id_empleado || null, id_vehiculo || null,
        JSON.stringify(datos_extra || {}), origen || 'manual', id_usuario || null,
        cantidad == null ? null : cantidad, subtotal_material == null ? null : subtotal_material,
        costo_final_flete == null ? null : costo_final_flete, id_stock_ingreso || null,
        CombustibleModel.horaHHMM(hora), CombustibleModel.texto(nro_factura), CombustibleModel.texto(nro_remito),
        litrosNum > 0 ? litrosNum : null, id_chofer || null, id_combustible || null])
    return rows[0].id
  },

  async listar(filtros = {}) {
    const { where, params } = construirFiltro(filtros)
    return (await query(`
      SELECT e.*,
             p.nombre AS proveedor_nombre,
             pr.nombre AS producto_nombre,
             pr.unidad_medida AS producto_unidad,
             NULLIF(TRIM(COALESCE(emp.nombre,'') || ' ' || COALESCE(emp.apellido,'')), '') AS empleado_nombre,
             NULLIF(TRIM(COALESCE(v.nombre,'') || CASE WHEN v.patente IS NOT NULL THEN ' (' || v.patente || ')' ELSE '' END), '') AS vehiculo_nombre,
             u.nombre AS usuario_nombre,
             NULLIF(TRIM(COALESCE(ch.nombre,'') || ' ' || COALESCE(ch.apellido,'')), '') AS chofer_nombre,
             COALESCE(e.periodo, pe.periodo) AS periodo,
             -- Para el detalle (Ver compra): el recibo del sueldo, el km de la carga y la última edición
             pe.tipo AS pago_tipo, pe.descripcion AS pago_descripcion, pe.sueldo_base AS pago_base, pe.descuentos AS pago_descuentos, pe.adiciones AS pago_adiciones,
             cb.km_al_cargar AS carga_km,
             ed.created_at AS editado_en, ued.nombre AS editado_por
      FROM egresos e
      LEFT JOIN proveedores p     ON p.id  = e.id_proveedor
      LEFT JOIN productos pr      ON pr.id = e.id_producto
      LEFT JOIN empleados emp     ON emp.id = e.id_empleado
      LEFT JOIN empleados ch      ON ch.id  = e.id_chofer
      LEFT JOIN flota_vehiculos v ON v.id  = e.id_vehiculo
      LEFT JOIN users u           ON u.id  = e.id_usuario
      LEFT JOIN pagos_empleado pe ON pe.id = e.id_pago_empleado
      LEFT JOIN combustible cb    ON cb.id = e.id_combustible
      LEFT JOIN LATERAL (
        SELECT a.created_at, a.id_usuario FROM auditoria a
        WHERE a.entidad_tipo = 'egreso' AND a.entidad_id = e.id AND a.accion = 'editar'
        ORDER BY a.created_at DESC LIMIT 1
      ) ed ON true
      LEFT JOIN users ued         ON ued.id = ed.id_usuario
      ${where}
      ORDER BY e.fecha DESC, e.id DESC
    `, params)).rows
  },

  async resumen(filtros = {}) {
    const { where, params } = construirFiltro(filtros)
    const rows = (await query(`
      SELECT e.categoria, COUNT(*) AS c, COALESCE(SUM(e.monto),0) AS s
      FROM egresos e
      LEFT JOIN pagos_empleado pe ON pe.id = e.id_pago_empleado
      ${where}
      GROUP BY e.categoria
    `, params)).rows
    const porCategoria = {}
    let total = 0, count = 0
    rows.forEach(r => { porCategoria[r.categoria] = { monto: Number(r.s), count: Number(r.c) }; total += Number(r.s); count += Number(r.c) })
    return { total, count, porCategoria, ...(await EgresosModel.resumenMaterial(filtros)) }
  },

  // Material comprado según los filtros: por producto y, dentro de cada uno, por proveedor.
  // Las cantidades se suman solo dentro de un mismo producto (no se mezclan tn con m³).
  // `sinCantidad` cuenta las compras de material que no tienen cantidad registrada (las
  // viejas que no se pudieron vincular al ingreso de stock): no entran en las sumas.
  async resumenMaterial(filtros = {}) {
    if (filtros.categoria && filtros.categoria !== 'material') return { material: [], materialSinCantidad: 0 }
    const f = construirFiltro({ ...filtros, categoria: 'material' })
    const rows = (await query(`
      SELECT e.id_producto, pr.nombre AS producto, pr.unidad_medida AS unidad,
             e.id_proveedor, p.nombre AS proveedor,
             COUNT(*) AS c, COALESCE(SUM(e.cantidad),0) AS cant, COALESCE(SUM(e.monto),0) AS s
      FROM egresos e
      LEFT JOIN pagos_empleado pe ON pe.id = e.id_pago_empleado
      LEFT JOIN productos pr      ON pr.id = e.id_producto
      LEFT JOIN proveedores p     ON p.id  = e.id_proveedor
      ${f.where} AND e.cantidad IS NOT NULL
      GROUP BY e.id_producto, pr.nombre, pr.unidad_medida, e.id_proveedor, p.nombre
      ORDER BY pr.nombre, p.nombre
    `, f.params)).rows
    const sinCantidad = Number((await query(`
      SELECT COUNT(*) AS n FROM egresos e
      LEFT JOIN pagos_empleado pe ON pe.id = e.id_pago_empleado
      ${f.where} AND e.cantidad IS NULL
    `, f.params)).rows[0].n)
    const porProducto = new Map()
    rows.forEach(r => {
      const k = String(r.id_producto)
      if (!porProducto.has(k)) porProducto.set(k, { id_producto: r.id_producto, producto: r.producto || 'Sin producto', unidad: r.unidad || '', cantidad: 0, monto: 0, count: 0, proveedores: [] })
      const g = porProducto.get(k)
      g.cantidad += Number(r.cant); g.monto += Number(r.s); g.count += Number(r.c)
      g.proveedores.push({ id: r.id_proveedor, nombre: r.proveedor || 'Sin proveedor', cantidad: Number(r.cant), monto: Number(r.s), count: Number(r.c) })
    })
    return { material: [...porProducto.values()], materialSinCantidad: sinCantidad }
  },

  async obtener(id) {
    return (await query(`SELECT * FROM egresos WHERE id = ?`, [id])).rows[0]
  },

  // Una compra / pago con todo lo que muestra el detalle y lo que necesita el formulario
  // de edición: el ingreso de stock (material) y la carga del camión (combustible).
  async obtenerDetalle(id) {
    const e = (await this.listar({ id }))[0]
    if (!e) return null
    if (e.id_stock_ingreso) {
      e.ingreso = (await query(`SELECT * FROM stock_ingresos WHERE id = ?`, [e.id_stock_ingreso])).rows[0] || null
    }
    if (e.id_combustible) {
      e.carga = (await query(`SELECT * FROM combustible WHERE id = ?`, [e.id_combustible])).rows[0] || null
    }
    return e
  },

  // Corrige una compra / pago y todo lo que esa operación movió (los sueldos se corrigen con
  // PagosEmpleadoModel.actualizar, que también toca su recibo):
  //  · Material vinculado a su ingreso de stock: se revierte lo que entró (producto y
  //    cantidad anteriores) y entra lo nuevo; el ingreso de stock toma producto, proveedor,
  //    cantidad, costos y fecha nuevos. Si algún stock quedara negativo, no se guarda nada.
  //  · Combustible con "Impacta en autonomía del camión": la carga del camión se corrige
  //    con los datos nuevos; si se destilda se borra, y si se tilda se crea.
  // La deuda con una estación se arma siempre desde las tablas, así que se corrige sola.
  // `datos`: los campos ya resueltos por el controlador según la categoría.
  // `carga`: null si la categoría no usa el campo 'carga'; si no, { impacta, km_al_cargar }.
  async editar(id, datos, { carga = null } = {}) {
    return await transaction(async (q) => {
      const e = (await q(`SELECT * FROM egresos WHERE id = ? FOR UPDATE`, [id])).rows[0]
      if (!e) throw new Error('La compra / pago no existe.')
      if (e.origen === 'tercero') throw new Error(NO_EDITAR_TERCERO)
      const fletero = await FleterosModel.asegurar(datos.fletero, q)

      // ── Material: stock e ingreso de stock ──
      let stockMovido = false
      if (e.categoria === 'material' && e.id_stock_ingreso) {
        const ing = (await q(`SELECT * FROM stock_ingresos WHERE id = ?`, [e.id_stock_ingreso])).rows[0]
        if (ing) {
          const cant = Number(datos.cantidad)
          await moverStock(q, ing.id_producto, -(Number(ing.cantidad) || 0))
          await moverStock(q, datos.id_producto, cant)
          await verificarStock(q, [ing.id_producto, datos.id_producto], 'Con este cambio')
          await q(`
            UPDATE stock_ingresos SET id_producto = ?, id_proveedor = ?, cantidad = ?, costo_unitario = ?, costo_flete = ?,
                                      observaciones = ?, fecha = COALESCE(?, fecha)
            WHERE id = ?
          `, [datos.id_producto, datos.id_proveedor || null, cant, (Number(datos.subtotal_material) || 0) / cant,
              (Number(datos.costo_final_flete) || 0) / cant, datos.observaciones ?? datos.descripcion ?? '', datos.fecha || null, ing.id])
          stockMovido = true
        }
      }

      // ── Combustible: la carga del camión ──
      let id_combustible = e.id_combustible
      if (carga) {
        const datosCarga = {
          id_vehiculo: datos.id_vehiculo, id_chofer: datos.id_chofer, id_proveedor: datos.id_proveedor,
          litros: datos.litros, costo_total: datos.monto, km_al_cargar: carga.km_al_cargar,
          fecha: datos.fecha || e.fecha, hora: datos.hora, nro_factura: datos.nro_factura, nro_remito: datos.nro_remito,
        }
        if (carga.impacta && id_combustible) await CombustibleModel.actualizar(id_combustible, datosCarga, q)
        else if (carga.impacta) id_combustible = await CombustibleModel.crear(datosCarga, q)
        else if (id_combustible) {
          await q(`UPDATE egresos SET id_combustible = NULL WHERE id = ?`, [id])
          await q(`DELETE FROM combustible WHERE id = ?`, [id_combustible])
          id_combustible = null
        }
      }

      const litros = parseFloat(datos.litros)
      await q(`
        UPDATE egresos SET fecha = COALESCE(?, fecha), descripcion = ?, monto = ?, metodo_pago = ?, fletero = ?, periodo = ?,
                           id_proveedor = ?, id_producto = ?, id_empleado = ?, id_vehiculo = ?, datos_extra = ?,
                           cantidad = ?, subtotal_material = ?, costo_final_flete = ?,
                           hora = ?, nro_factura = ?, nro_remito = ?, litros = ?, id_chofer = ?, id_combustible = ?
        WHERE id = ?
      `, [datos.fecha || null, datos.descripcion || '', parseFloat(datos.monto) || 0, datos.metodo_pago || null, fletero,
          (datos.periodo || '').trim() || null, datos.id_proveedor || null, datos.id_producto || null,
          datos.id_empleado || null, datos.id_vehiculo || null, JSON.stringify(datos.datos_extra || {}),
          datos.cantidad == null ? null : datos.cantidad,
          datos.subtotal_material == null ? null : datos.subtotal_material,
          datos.costo_final_flete == null ? null : datos.costo_final_flete,
          CombustibleModel.horaHHMM(datos.hora), CombustibleModel.texto(datos.nro_factura), CombustibleModel.texto(datos.nro_remito),
          litros > 0 ? litros : null, datos.id_chofer || null, id_combustible || null, id])
      return { antes: e, stockMovido }
    })
  },

  // Fleteros ya cargados en alguna compra de material, para el desplegable del filtro.
  async fleteros() {
    const { rows } = await query(`
      SELECT DISTINCT fletero FROM egresos
      WHERE fletero IS NOT NULL AND fletero <> ''
      ORDER BY fletero
    `)
    return rows.map(r => r.fletero)
  },

  // Si el egreso es el pago de un sueldo, también se borra ese pago de la ficha del
  // empleado (y su recibo), para que las dos listas no queden desalineadas. Lo mismo con la
  // carga de combustible que el pago creó en el camión: sin el pago, la carga se borra también.
  // Y con la compra de material: sale del stock lo que había entrado y se borra su ingreso de
  // stock (si eso dejara el stock negativo, no se borra nada).
  // Devuelve { material, stockRevertido } para que el aviso diga qué pasó con el stock.
  async eliminar(id) {
    return await transaction(async (q) => {
      const e = (await q(`SELECT id, categoria, origen, id_pago_empleado, id_combustible, id_stock_ingreso FROM egresos WHERE id = ? FOR UPDATE`, [id])).rows[0]
      if (!e) return null
      if (e.origen === 'tercero') throw new Error(NO_EDITAR_TERCERO)
      let stockRevertido = false
      if (e.categoria === 'material' && e.id_stock_ingreso) {
        const ing = (await q(`SELECT id, id_producto, cantidad FROM stock_ingresos WHERE id = ?`, [e.id_stock_ingreso])).rows[0]
        if (ing) {
          await moverStock(q, ing.id_producto, -(Number(ing.cantidad) || 0))
          await verificarStock(q, [ing.id_producto], 'Al eliminar esta compra')
          stockRevertido = true
        }
      }
      await q(`DELETE FROM egresos WHERE id = ?`, [id])
      if (stockRevertido) await q(`DELETE FROM stock_ingresos WHERE id = ?`, [e.id_stock_ingreso])
      await q(`DELETE FROM pagos_empleado WHERE id_egreso = ? ${e.id_pago_empleado ? 'OR id = ?' : ''}`,
        e.id_pago_empleado ? [id, e.id_pago_empleado] : [id])
      if (e.id_combustible) await q(`DELETE FROM combustible WHERE id = ?`, [e.id_combustible])
      return { material: e.categoria === 'material', stockRevertido }
    })
  },
}

module.exports = EgresosModel
