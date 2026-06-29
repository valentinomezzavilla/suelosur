'use strict'
const { query, transaction } = require('../config/db')

const SQL_ULTIMO_MOV = `
  SELECT m.* FROM (
    SELECT m.*, ROW_NUMBER() OVER (PARTITION BY id_contenedor ORDER BY fecha_movimiento DESC, id DESC) AS rn
    FROM movimiento_contenedor m
  ) m WHERE m.rn = 1
`

const AlquileresModel = {

  async listarPorEstado() {
    const baseSelect = `
      SELECT op.id, op.nro_op, op.nro_remito, op.estado, op.fecha_emision, op.fecha_entrega_planificada,
             cli.nombre AS cliente_nombre, cli.tel_whatsapp,
             oc.id AS id_op_contenedor, oc.domicilio_entrega, oc.zona_entrega,
             oc.plazo_alquiler, oc.precio_alquiler, oc.id_contenedor,
             cont.numero_contenedor,
             um.estado_paso AS contenedor_estado, um.fecha_movimiento AS fecha_entrega_real,
             (LEFT(um.fecha_movimiento, 10)::date + oc.plazo_alquiler) AS fecha_fin_estimada,
             ((LEFT(um.fecha_movimiento, 10)::date + oc.plazo_alquiler) - CURRENT_DATE) AS dias_restantes,
             (CURRENT_DATE - LEFT(um.fecha_movimiento, 10)::date) AS dias_en_estado
      FROM op_encabezado op
      JOIN clientes cli ON cli.id = op.id_cliente
      LEFT JOIN op_detalle_contenedor oc ON oc.id_orden_pedido = op.id
      LEFT JOIN contenedores cont ON cont.id = oc.id_contenedor
      LEFT JOIN (${SQL_ULTIMO_MOV}) um ON um.id_contenedor = oc.id_contenedor
      WHERE op.tipo_op = 'C'
    `
    const actuales = (await query(`${baseSelect}
      AND op.estado = 'entregado' AND um.estado_paso IN ('entregado','en_alquiler','a_retirar')
      ORDER BY fecha_fin_estimada ASC`)).rows
    const porFinalizar = actuales.filter(a => a.dias_restantes != null && a.dias_restantes <= 1)
    const programados  = (await query(`${baseSelect}
      AND op.estado IN ('pendiente','despachado')
      ORDER BY op.fecha_entrega_planificada ASC NULLS LAST, op.created_at ASC`)).rows
    return { actuales, porFinalizar, programados }
  },

  async obtener(id) {
    const op = (await query(`
      SELECT op.*, cli.nombre AS cliente_nombre, cli.tel_whatsapp, cli.domicilio_ppal,
             u.nombre AS administrativo_nombre
      FROM op_encabezado op
      JOIN clientes cli ON cli.id = op.id_cliente
      JOIN users    u   ON u.id  = op.id_administrativo
      WHERE op.id = ? AND op.tipo_op = 'C'
    `, [id])).rows[0]
    if (!op) return null

    op.detalle = (await query(`
      SELECT oc.*, cont.numero_contenedor, cont.estado_general
      FROM op_detalle_contenedor oc LEFT JOIN contenedores cont ON cont.id = oc.id_contenedor
      WHERE oc.id_orden_pedido = ? LIMIT 1
    `, [id])).rows[0]

    if (op.detalle?.id_contenedor) {
      op.movimientos = (await query(`
        SELECT m.*, u.nombre AS chofer_nombre, f.patente AS camion_patente
        FROM movimiento_contenedor m
        LEFT JOIN users u ON u.id = m.id_chofer
        LEFT JOIN flota_vehiculos f ON f.id = m.id_camion
        WHERE m.id_contenedor = ? AND m.id_op_contenedor = ?
        ORDER BY m.fecha_movimiento ASC, m.id ASC
      `, [op.detalle.id_contenedor, op.detalle.id])).rows

      op.estadoContenedor = (await query(`
        SELECT estado_paso, fecha_movimiento FROM movimiento_contenedor
        WHERE id_contenedor = ? ORDER BY fecha_movimiento DESC, id DESC LIMIT 1
      `, [op.detalle.id_contenedor])).rows[0]

      const movEntrega = (await query(`
        SELECT fecha_movimiento FROM movimiento_contenedor
        WHERE id_contenedor = ? AND id_op_contenedor = ? AND estado_paso = 'entregado'
        ORDER BY fecha_movimiento ASC LIMIT 1
      `, [op.detalle.id_contenedor, op.detalle.id])).rows[0]
      op.diasEnDomicilio = movEntrega
        ? Math.floor((Date.now() - new Date(movEntrega.fecha_movimiento).getTime()) / 86400000)
        : null
      // Fecha exacta de fin de alquiler = fecha de entrega + plazo (días)
      if (movEntrega) {
        const ini = new Date(String(movEntrega.fecha_movimiento).slice(0, 10) + 'T00:00:00')
        ini.setDate(ini.getDate() + (op.detalle.plazo_alquiler || 0))
        op.fechaFinAlquiler = ini.toISOString().slice(0, 10)
        const hoy = new Date(); hoy.setHours(0, 0, 0, 0)
        op.diasRestantes = Math.round((ini - hoy) / 86400000)
      } else {
        op.fechaFinAlquiler = null; op.diasRestantes = null
      }
    } else {
      op.movimientos = []; op.estadoContenedor = null; op.diasEnDomicilio = null
      op.fechaFinAlquiler = null; op.diasRestantes = null
    }
    return op
  },

  async crear({ id_cliente, id_administrativo, domicilio_entrega, domicilio_calle, domicilio_numero, zona_entrega, plazo_alquiler, precio_alquiler, id_contenedor, metodo_pago, observaciones }) {
    if (id_contenedor) {
      const reservado = (await query(`
        SELECT 1 FROM op_detalle_contenedor oc
        JOIN op_encabezado op ON op.id = oc.id_orden_pedido
        LEFT JOIN (${SQL_ULTIMO_MOV}) lm ON lm.id_contenedor = oc.id_contenedor
        WHERE oc.id_contenedor = ? AND op.estado != 'anulado'
          AND (op.estado IN ('pendiente','despachado')
               OR (op.estado = 'entregado' AND lm.estado_paso IN ('en_transito','entregado','en_alquiler','a_retirar')))
      `, [id_contenedor])).rows[0]
      if (reservado) throw new Error('El contenedor seleccionado ya no está disponible.')
    }
    const { nro }     = (await query(`SELECT COALESCE(MAX(nro_op), 0) + 1 AS nro FROM op_encabezado`)).rows[0]
    const { nro_rem } = (await query(`SELECT COALESCE(MAX(nro_remito), 0) + 1 AS nro_rem FROM op_encabezado`)).rows[0]
    return await transaction(async (q) => {
      const { rows } = await q(`INSERT INTO op_encabezado (id_cliente, id_administrativo, tipo_op, nro_op, nro_remito, estado, metodo_pago, observaciones) VALUES (?, ?, 'C', ?, ?, 'pendiente', ?, ?) RETURNING id`,
        [id_cliente, id_administrativo, nro, nro_rem, metodo_pago || null, observaciones || ''])
      const id_op = rows[0].id
      await q(`INSERT INTO op_detalle_contenedor (id_orden_pedido, id_contenedor, domicilio_entrega, domicilio_calle, domicilio_numero, zona_entrega, plazo_alquiler, precio_alquiler, metodo_pago) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id_op, id_contenedor || null,
         domicilio_entrega || '', domicilio_calle || null, domicilio_numero || null,
         zona_entrega || '', parseInt(plazo_alquiler) || 5, parseFloat(precio_alquiler) || 0,
         metodo_pago || null])
      return { id: id_op, nro_op: nro, nro_remito: nro_rem }
    })
  },

  async asignarContenedor(id_op, id_contenedor) {
    await query(`UPDATE op_detalle_contenedor SET id_contenedor = ? WHERE id_orden_pedido = ?`, [id_contenedor, id_op])
  },

  // Edición de los datos comerciales / de entrega del alquiler
  async actualizar(id_op, { calle, numero, zona_entrega, plazo_alquiler, precio_alquiler, metodo_pago, observaciones, fecha_entrega_planificada }) {
    const domicilio_entrega = `${calle || ''} ${numero || ''}`.trim()
    await transaction(async (q) => {
      await q(`UPDATE op_encabezado SET observaciones = ?, metodo_pago = ?, fecha_entrega_planificada = ? WHERE id = ?`,
        [observaciones || '', metodo_pago || null, fecha_entrega_planificada || null, id_op])
      await q(`
        UPDATE op_detalle_contenedor
        SET domicilio_entrega = ?, domicilio_calle = ?, domicilio_numero = ?, zona_entrega = ?,
            plazo_alquiler = ?, precio_alquiler = ?, metodo_pago = ?
        WHERE id_orden_pedido = ?
      `, [domicilio_entrega, calle || null, numero || null, zona_entrega || '',
          parseInt(plazo_alquiler) || 5, parseFloat(precio_alquiler) || 0, metodo_pago || null, id_op])
    })
  },

  async despachar(id_op) {
    const oc = (await query(`SELECT id, id_contenedor FROM op_detalle_contenedor WHERE id_orden_pedido = ? LIMIT 1`, [id_op])).rows[0]
    if (!oc?.id_contenedor) throw new Error('No hay contenedor asignado.')
    await transaction(async (q) => {
      await q(`UPDATE op_encabezado SET estado = 'despachado' WHERE id = ? AND estado = 'pendiente'`, [id_op])
      await q(`INSERT INTO movimiento_contenedor (id_contenedor, id_op_contenedor, estado_paso, observaciones) VALUES (?, ?, 'en_transito', 'Salida a entregar')`,
        [oc.id_contenedor, oc.id])
    })
  },

  async entregar(id_op) {
    const oc = (await query(`SELECT id, id_contenedor FROM op_detalle_contenedor WHERE id_orden_pedido = ? LIMIT 1`, [id_op])).rows[0]
    if (!oc?.id_contenedor) throw new Error('No hay contenedor asignado.')
    await transaction(async (q) => {
      await q(`UPDATE op_encabezado SET estado = 'entregado' WHERE id = ? AND estado IN ('pendiente','despachado')`, [id_op])
      await q(`INSERT INTO movimiento_contenedor (id_contenedor, id_op_contenedor, estado_paso, observaciones) VALUES (?, ?, 'entregado', 'Entregado en domicilio')`,
        [oc.id_contenedor, oc.id])
    })
  },

  async registrarRetiro(id_op) {
    const oc = (await query(`SELECT id, id_contenedor FROM op_detalle_contenedor WHERE id_orden_pedido = ? LIMIT 1`, [id_op])).rows[0]
    if (!oc?.id_contenedor) throw new Error('No hay contenedor asignado.')
    await query(`INSERT INTO movimiento_contenedor (id_contenedor, id_op_contenedor, estado_paso, observaciones) VALUES (?, ?, 'en_transito', 'Retirado de domicilio')`,
      [oc.id_contenedor, oc.id])
  },

  async devolverAPlanta(id_op) {
    const oc = (await query(`SELECT id, id_contenedor FROM op_detalle_contenedor WHERE id_orden_pedido = ? LIMIT 1`, [id_op])).rows[0]
    if (!oc?.id_contenedor) throw new Error('No hay contenedor asignado.')
    await query(`INSERT INTO movimiento_contenedor (id_contenedor, id_op_contenedor, estado_paso, observaciones) VALUES (?, ?, 'vaciado', 'Devuelto a planta')`,
      [oc.id_contenedor, oc.id])
  },

  async anular(id_op) {
    await query(`UPDATE op_encabezado SET estado = 'anulado' WHERE id = ? AND estado IN ('pendiente','despachado')`, [id_op])
  },

  async clientes() {
    return (await query(`SELECT id, nombre FROM clientes WHERE activo = 1 ORDER BY nombre`)).rows
  },

  async contenedoresDisponibles() {
    // Contenedores reservados por una orden vigente que todavía no liberó la unidad:
    //  - 'pendiente'  → alquiler creado, aún no despachado (no genera movimiento, pero el contenedor ya está comprometido)
    //  - 'despachado' → en camino al cliente
    //  - 'entregado' que NO volvió a planta (sigue en domicilio / a retirar)
    // Un alquiler 'entregado' ya devuelto (último movimiento en_planta/vaciado) NO reserva.
    const SQL_RESERVADOS = `
      SELECT oc.id_contenedor
      FROM op_detalle_contenedor oc
      JOIN op_encabezado op ON op.id = oc.id_orden_pedido
      LEFT JOIN (${SQL_ULTIMO_MOV}) lm ON lm.id_contenedor = oc.id_contenedor
      WHERE oc.id_contenedor IS NOT NULL
        AND op.estado != 'anulado'
        AND (
          op.estado IN ('pendiente','despachado')
          OR (op.estado = 'entregado' AND lm.estado_paso IN ('en_transito','entregado','en_alquiler','a_retirar'))
        )
    `

    const disponibles = (await query(`
      SELECT c.id, c.numero_contenedor FROM contenedores c
      JOIN (${SQL_ULTIMO_MOV}) um ON um.id_contenedor = c.id
      WHERE c.activo = 1 AND c.estado_general = 'operativo'
        AND um.estado_paso IN ('en_planta','vaciado')
        AND c.id NOT IN (${SQL_RESERVADOS})
      ORDER BY c.numero_contenedor
    `)).rows

    const porLiberar = (await query(`
      SELECT c.id, c.numero_contenedor,
             op.id AS alquiler_actual_id, op.nro_op,
             cli.nombre AS cliente_actual,
             oc.plazo_alquiler,
             (LEFT(um.fecha_movimiento, 10)::date + oc.plazo_alquiler) AS fecha_liberacion,
             ((LEFT(um.fecha_movimiento, 10)::date + oc.plazo_alquiler) - CURRENT_DATE) * 24 AS horas_restantes
      FROM contenedores c
      JOIN (${SQL_ULTIMO_MOV}) um ON um.id_contenedor = c.id
      JOIN op_detalle_contenedor oc ON oc.id_contenedor = c.id AND oc.id = um.id_op_contenedor
      JOIN op_encabezado op ON op.id = oc.id_orden_pedido
      JOIN clientes cli ON cli.id = op.id_cliente
      WHERE c.activo = 1
        AND c.estado_general = 'operativo'
        AND um.estado_paso IN ('entregado','en_alquiler','a_retirar')
        AND ((LEFT(um.fecha_movimiento, 10)::date + oc.plazo_alquiler) - CURRENT_DATE) BETWEEN 0 AND 2
        AND oc.alquiler_siguiente_id IS NULL
      ORDER BY horas_restantes ASC
    `)).rows

    return { disponibles, porLiberar }
  },

  async crearProgramado({ id_cliente, id_administrativo, domicilio_entrega, domicilio_calle, domicilio_numero, zona_entrega, plazo_alquiler, precio_alquiler, id_contenedor, metodo_pago, observaciones, alquiler_actual_id }) {
    const tieneProximoAlquiler = (await query(`
      SELECT 1 FROM op_detalle_contenedor oc
      JOIN op_encabezado op ON op.id = oc.id_orden_pedido
      WHERE oc.id_contenedor = ? AND oc.alquiler_siguiente_id IS NOT NULL AND op.estado != 'anulado'
    `, [id_contenedor])).rows[0]
    if (tieneProximoAlquiler) throw new Error('Este contenedor ya tiene un alquiler programado.')

    const { nro }     = (await query(`SELECT COALESCE(MAX(nro_op), 0) + 1 AS nro FROM op_encabezado`)).rows[0]
    const { nro_rem } = (await query(`SELECT COALESCE(MAX(nro_remito), 0) + 1 AS nro_rem FROM op_encabezado`)).rows[0]
    return await transaction(async (q) => {
      const { rows } = await q(`
        INSERT INTO op_encabezado (id_cliente, id_administrativo, tipo_op, nro_op, nro_remito, estado, estado_programacion, metodo_pago, observaciones)
        VALUES (?, ?, 'C', ?, ?, 'pendiente', 'programado', ?, ?)
        RETURNING id
      `, [id_cliente, id_administrativo, nro, nro_rem, metodo_pago || null, observaciones || ''])
      const id_op = rows[0].id

      await q(`
        INSERT INTO op_detalle_contenedor (id_orden_pedido, id_contenedor, domicilio_entrega, domicilio_calle, domicilio_numero, zona_entrega, plazo_alquiler, precio_alquiler, metodo_pago)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [id_op, id_contenedor, domicilio_entrega || '',
          domicilio_calle || null, domicilio_numero || null,
          zona_entrega || '', parseInt(plazo_alquiler) || 5, parseFloat(precio_alquiler) || 0,
          metodo_pago || null])

      await q(`
        UPDATE op_detalle_contenedor SET alquiler_siguiente_id = ?
        WHERE id_orden_pedido = ? AND id_contenedor = ?
      `, [id_op, alquiler_actual_id, id_contenedor])

      return { id: id_op, nro_op: nro, nro_remito: nro_rem }
    })
  },

  async activarProgramado(id_op) {
    const op = (await query(`SELECT estado_programacion FROM op_encabezado WHERE id = ?`, [id_op])).rows[0]
    if (!op || op.estado_programacion !== 'programado') return
    await query(`UPDATE op_encabezado SET estado_programacion = 'activo' WHERE id = ?`, [id_op])
  },
}

module.exports = AlquileresModel
