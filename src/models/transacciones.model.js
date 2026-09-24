'use strict'
const { query, transaction } = require('../config/db')
const ClientesModel = require('./clientes.model')
const { SQL_DESCRIPCION_DETALLE } = require('../utils/contenedor')

// Prefijos para el código legible de cada tipo de transacción
const PREFIJO = { 'Venta Cantera': 'CAN', 'Venta Viaje': 'VIA', 'Alquiler': 'CON', 'Maquinaria': 'MAQ', 'Ajuste': 'AJU' }

// Código normalizado, p.ej. CAN-000001. Fallback a TRX si no hay numero/tipo.
function codigoTransaccion(t) {
  if (!t) return ''
  const pre = PREFIJO[t.tipo] || 'TRX'
  if (t.numero == null) return `${pre}-——`
  return `${pre}-${String(t.numero).padStart(6, '0')}`
}

const TransaccionesModel = {

  PREFIJO,
  codigo: codigoTransaccion,

  async crear({ tipo, id_op_encabezado, nro_remito, cliente_id, cliente, monto, descripcion, metodo_pago, fecha }) {
    const { n } = (await query(`SELECT COALESCE(MAX(numero),0) + 1 AS n FROM transacciones WHERE tipo = ?`, [tipo])).rows[0]
    // fecha opcional: si no se pasa, usa la fecha/hora actual (carga histórica la puede fijar en el pasado).
    const { rows } = await query(`
      INSERT INTO transacciones (tipo, numero, id_op_encabezado, nro_remito, cliente_id, cliente, monto, descripcion, metodo_pago, fecha)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')))
      RETURNING id
    `, [tipo, n, id_op_encabezado || null, nro_remito || null, cliente_id || null,
        cliente || '', monto || 0, descripcion || '', metodo_pago || 'efectivo', fecha || null])
    return rows[0].id
  },

  // ¿La operación ya generó su ingreso? Evita cobrar dos veces la misma operación
  // (por ejemplo, alquileres viejos que ya habían cobrado al entregar).
  async existePorOperacion(id_op_encabezado) {
    if (!id_op_encabezado) return false
    const r = (await query(`SELECT 1 FROM transacciones WHERE id_op_encabezado = ? LIMIT 1`, [id_op_encabezado])).rows[0]
    return !!r
  },

  async obtener(id) {
    return (await query(`SELECT * FROM transacciones WHERE id = ?`, [id])).rows[0]
  },

  // Cambia el método de pago de una transacción ya cargada (p.ej. se finalizó como
  // "efectivo" y en realidad era "cuenta corriente"). Mantiene todo consistente:
  //  · Si sale de cuenta corriente: revierte el cargo pendiente en la cuenta del cliente.
  //  · Si entra a cuenta corriente: genera el cargo correspondiente.
  //  · El método de la OP asociada (si tiene) se actualiza igual, para que el resto
  //    de la app (remito, detalle de venta) muestre lo mismo.
  async cambiarMetodoPago(id, nuevoMetodo) {
    const METODOS = ['efectivo', 'transferencia', 'cheque', 'cuenta_corriente']
    if (!METODOS.includes(nuevoMetodo)) throw new Error('Método de pago inválido.')

    const tx = (await query(`SELECT * FROM transacciones WHERE id = ?`, [id])).rows[0]
    if (!tx) throw new Error('La transacción no existe.')
    const anterior = tx.metodo_pago || 'efectivo'
    if (anterior === nuevoMetodo) return

    if (nuevoMetodo === 'cuenta_corriente' && (!tx.cliente_id || !tx.id_op_encabezado)) {
      throw new Error('No se puede pasar a cuenta corriente: la transacción no tiene cliente y operación asociados.')
    }
    if (nuevoMetodo === 'cuenta_corriente') {
      const errCC = await require('./clientes.model').errorCuentaCorriente(tx.cliente_id)
      if (errCC) throw new Error(errCC)
    }
    // Las ventas (tipo M) llevan el cargo con la regla única de VentasModel
    const esVenta = tx.id_op_encabezado
      ? (await query(`SELECT tipo_op FROM op_encabezado WHERE id = ?`, [tx.id_op_encabezado])).rows[0]?.tipo_op === 'M'
      : false

    await transaction(async (q) => {
      await q(`UPDATE transacciones SET metodo_pago = ? WHERE id = ?`, [nuevoMetodo, id])
      if (tx.id_op_encabezado) {
        await q(`UPDATE op_encabezado SET metodo_pago = ? WHERE id = ?`, [nuevoMetodo, tx.id_op_encabezado])
      }
      if (esVenta) {
        await require('./ventas.model').sincronizarCargoCC(tx.id_op_encabezado, q)
        return
      }

      // Salía de cta. corriente: revertir el cargo (si seguía en pie) en el saldo del cliente.
      if (anterior === 'cuenta_corriente' && tx.id_op_encabezado) {
        const deuda = (await q(
          `SELECT id, cliente_id, monto FROM movimientos_cuenta WHERE id_op_encabezado = ? AND tipo = 'deuda' LIMIT 1`,
          [tx.id_op_encabezado]
        )).rows[0]
        if (deuda) {
          await q(`DELETE FROM movimientos_cuenta WHERE id = ?`, [deuda.id])
          await q(`UPDATE clientes SET saldo = saldo - ? WHERE id = ?`, [Number(deuda.monto), deuda.cliente_id])
        }
      }

      // Entra a cta. corriente: generar el cargo correspondiente.
      if (nuevoMetodo === 'cuenta_corriente' && tx.id_op_encabezado) {
        const monto = Number(tx.monto) || 0
        await q(
          `INSERT INTO movimientos_cuenta (cliente_id, tipo, descripcion, monto, id_op_encabezado)
           VALUES (?, 'deuda', ?, ?, ?)`,
          [tx.cliente_id, `${tx.tipo}: ${tx.descripcion || ''}`.trim(), -monto, tx.id_op_encabezado]
        )
        await q(`UPDATE clientes SET saldo = saldo - ? WHERE id = ?`, [monto, tx.cliente_id])
      }
    })
  },

  // Elimina la transacción y, si tiene una operación detrás, la operación entera con
  // todo lo que cuelga de ella. Si solo se borrara la transacción, la operación
  // seguiría contando en el dashboard y en los listados.
  // El orden importa: ninguna FK está en cascada, así que van primero los hijos.
  async eliminar(id) {
    const tx = (await query(`SELECT id, id_op_encabezado FROM transacciones WHERE id = ?`, [id])).rows[0]
    if (!tx) throw new Error('La transacción no existe.')
    const idOp = tx.id_op_encabezado

    // Estado de la operación: define qué stock hay que devolver
    const op = idOp
      ? (await query(`SELECT estado FROM op_encabezado WHERE id = ?`, [idOp])).rows[0]
      : null

    await transaction(async (q) => {
      await q(`DELETE FROM transacciones WHERE id = ?`, [id])
      if (!idOp) return

      // Devolver el stock que la operación había movido, si no la operación
      // desaparece pero el material sigue descontado.
      //  · entregada  → ya salió de planta: vuelve a cantidad_actual
      //  · en curso   → estaba reservado: se libera lo pendiente de entregar
      //  · anulada    → el stock ya se había liberado al anularla
      //  · contenedor (dias no nulo) → no movió stock
      if (op && op.estado !== 'anulado') {
        const detalles = (await q(
          `SELECT id_producto, cantidad_pedida FROM op_detalle_material WHERE id_orden_pedido = ? AND dias IS NULL`, [idOp])).rows
        for (const d of detalles) {
          if (op.estado === 'entregado') {
            await q(`UPDATE stock SET cantidad_actual = cantidad_actual + ? WHERE id_producto = ?`,
              [d.cantidad_pedida, d.id_producto])
          } else {
            await q(`UPDATE stock SET cant_pendiente_entregar = GREATEST(0, cant_pendiente_entregar - ?) WHERE id_producto = ?`,
              [d.cantidad_pedida, d.id_producto])
          }
        }
      }

      // Movimientos de contenedor / maquinaria (cuelgan del detalle, no de la op)
      await q(`DELETE FROM movimiento_contenedor WHERE id_op_contenedor IN
               (SELECT id FROM op_detalle_contenedor WHERE id_orden_pedido = ?)`, [idOp])
      await q(`DELETE FROM movimiento_maquinaria WHERE id_op_maquinaria IN
               (SELECT id FROM op_detalle_maquinaria WHERE id_orden_pedido = ?)`, [idOp])

      // Un alquiler puede estar encadenado como "próximo" de otro: hay que soltarlo
      await q(`UPDATE op_detalle_contenedor SET alquiler_siguiente_id = NULL WHERE alquiler_siguiente_id = ?`, [idOp])

      // Si la venta/alquiler era a cuenta corriente, el cargo en la cuenta del cliente
      // queda apuntando a una operación que está por desaparecer: hay que revertirlo
      // (si no, además de quedar un cargo fantasma, la FK contra op_encabezado rompe
      // el DELETE de más abajo).
      const deudas = (await q(
        `SELECT id, cliente_id, monto FROM movimientos_cuenta WHERE id_op_encabezado = ? AND tipo = 'deuda'`,
        [idOp]
      )).rows
      for (const deuda of deudas) {
        await q(`DELETE FROM movimientos_cuenta WHERE id = ?`, [deuda.id])
        await q(`UPDATE clientes SET saldo = saldo - ? WHERE id = ?`, [Number(deuda.monto), deuda.cliente_id])
      }

      await q(`DELETE FROM op_detalle_contenedor WHERE id_orden_pedido = ?`, [idOp])
      await q(`DELETE FROM op_detalle_maquinaria WHERE id_orden_pedido = ?`, [idOp])
      await q(`DELETE FROM op_detalle_material   WHERE id_orden_pedido = ?`, [idOp])
      await q(`DELETE FROM circuito_paradas      WHERE id_op_encabezado = ?`, [idOp])
      await q(`DELETE FROM historial_kilometraje WHERE id_op = ?`, [idOp])
      await q(`DELETE FROM rastreo_chofer        WHERE id_op = ?`, [idOp])
      // Otras transacciones de la misma operación (no debería haber, pero por las dudas)
      await q(`DELETE FROM transacciones WHERE id_op_encabezado = ?`, [idOp])
      await q(`DELETE FROM op_encabezado WHERE id = ?`, [idOp])
    })
    return { id, id_op_encabezado: idOp }
  },

  async listar() {
    return (await query(`SELECT * FROM transacciones ORDER BY created_at DESC`)).rows
  },

  // WHERE compartido por el listado, las métricas y el reporte. La fecha se compara por
  // día: guardada con hora ("2026-09-14 17:57:21") quedaba afuera del último día del rango.
  _filtro({ id, tipo, clienteId, cliente, fechaDesde, fechaHasta, montoMin, montoMax } = {}) {
    const wheres = []
    const params = []
    if (id)         { wheres.push('id = ?');                  params.push(id) }
    if (tipo && tipo !== 'todos') { wheres.push('tipo = ?');  params.push(tipo) }
    if (clienteId)  { wheres.push('cliente_id = ?');          params.push(clienteId) }
    // trim: un espacio de más al final (p.ej. un cliente sin apellido en el autocompletar)
    // no puede dejar el filtro sin resultados.
    const clienteTrim = (cliente || '').trim()
    if (clienteTrim) { wheres.push('cliente ILIKE ?');          params.push(`%${clienteTrim}%`) }
    if (fechaDesde) { wheres.push('LEFT(fecha, 10) >= ?');    params.push(fechaDesde) }
    if (fechaHasta) { wheres.push('LEFT(fecha, 10) <= ?');    params.push(fechaHasta) }
    if (montoMin)   { wheres.push('monto >= ?');              params.push(Number(montoMin)) }
    if (montoMax)   { wheres.push('monto <= ?');              params.push(Number(montoMax)) }
    return { where: wheres.length ? 'WHERE ' + wheres.join(' AND ') : '', params }
  },

  // Ventas a cuenta corriente: venta por venta, ¿el cliente ya la saldó?
  // (ver ClientesModel.saldadaPorOperacion — FIFO contra las deudas del cliente)
  async _marcarSaldadas(rows) {
    const idsCC = rows
      .filter(r => r.metodo_pago === 'cuenta_corriente' && r.id_op_encabezado)
      .map(r => r.id_op_encabezado)
    const saldadas = await ClientesModel.saldadaPorOperacion(idsCC)
    rows.forEach(r => {
      if (r.metodo_pago === 'cuenta_corriente' && r.id_op_encabezado) r.saldada = !!saldadas[r.id_op_encabezado]
    })
    return rows
  },

  _orden(sortBy, sortDir) {
    const validSorts = { created_at: 'created_at', monto: 'monto', fecha: 'fecha', tipo: 'tipo' }
    return `${validSorts[sortBy] || 'created_at'} ${sortDir === 'ASC' ? 'ASC' : 'DESC'}`
  },

  async filtrar({ page = 1, limit = 20, sortBy = 'created_at', sortDir = 'DESC', ...filtros } = {}) {
    const { where, params } = this._filtro(filtros)
    const offset = (page - 1) * limit

    const total = (await query(`SELECT COUNT(*) AS n FROM transacciones ${where}`, params)).rows[0]?.n || 0
    const sumaTotal = (await query(`SELECT COALESCE(SUM(monto), 0) AS s FROM transacciones ${where}`, params)).rows[0]?.s || 0
    const rows = (await query(`
      SELECT sub.*,
             (oe.archivo_remito IS NOT NULL AND oe.archivo_remito <> '') AS tiene_remito_firmado
      FROM (SELECT * FROM transacciones ${where}) sub
      LEFT JOIN op_encabezado oe ON oe.id = sub.id_op_encabezado
      ORDER BY sub.${this._orden(sortBy, sortDir)} LIMIT ? OFFSET ?
    `, [...params, limit, offset])).rows

    await this._marcarSaldadas(rows)
    return { rows, total, sumaTotal, page, limit, totalPaginas: Math.ceil(total / limit) }
  },

  // Todas las transacciones que coinciden con los filtros (sin paginar), para el reporte.
  // Para el reporte: separa lo que se vendió (productos/contenedor/maquinaria) de la
  // obra y las observaciones de la operación — la descripción guardada en la transacción
  // las mezcla todas en un solo texto libre, así que acá se arman aparte.
  async paraReporte({ sortBy = 'fecha', sortDir = 'ASC', ...filtros } = {}) {
    const { where, params } = this._filtro(filtros)
    const rows = (await query(`
      SELECT sub.*, oe.nro_op, oe.obra, oe.observaciones AS obs_operacion,
             mat.productos_str, c.numero_contenedor, m.maquinaria_nombre
      FROM (SELECT * FROM transacciones ${where}) sub
      LEFT JOIN op_encabezado oe ON oe.id = sub.id_op_encabezado
      LEFT JOIN (
        SELECT d.id_orden_pedido,
               STRING_AGG(${SQL_DESCRIPCION_DETALLE} || ' x' || CAST(d.cantidad_pedida AS TEXT), ', ') AS productos_str
        FROM op_detalle_material d JOIN productos p ON p.id = d.id_producto
        GROUP BY d.id_orden_pedido
      ) mat ON mat.id_orden_pedido = oe.id
      LEFT JOIN (
        SELECT oc.id_orden_pedido, cont.numero_contenedor
        FROM op_detalle_contenedor oc LEFT JOIN contenedores cont ON cont.id = oc.id_contenedor
      ) c ON c.id_orden_pedido = oe.id
      LEFT JOIN (
        SELECT dm.id_orden_pedido, maq.nombre AS maquinaria_nombre
        FROM op_detalle_maquinaria dm LEFT JOIN maquinaria maq ON maq.id = dm.id_maquinaria
      ) m ON m.id_orden_pedido = oe.id
      ORDER BY sub.${this._orden(sortBy, sortDir)}, sub.id
    `, params)).rows
    return this._marcarSaldadas(rows)
  },

  // Métricas agregadas del período/filtros (para las cards)
  async resumen(filtros = {}) {
    const { where, params } = this._filtro(filtros)
    const rows = (await query(`SELECT tipo, COUNT(*) AS c, COALESCE(SUM(monto),0) AS s FROM transacciones ${where} GROUP BY tipo`, params)).rows
    let total = 0, count = 0
    const porTipo = {}
    rows.forEach(r => { total += r.s; count += r.c; porTipo[r.tipo] = { monto: r.s, count: r.c } })
    const sumTipos = (...t) => t.reduce((a, k) => a + (porTipo[k]?.monto || 0), 0)
    return {
      total, count, porTipo,
      ventas: sumTipos('Venta Cantera', 'Venta Viaje'),
      alquileres: sumTipos('Alquiler', 'Maquinaria'),
    }
  },
}

module.exports = TransaccionesModel
