'use strict'
const { query, transaction } = require('../config/db')
const FlotaModel = require('./flota.model')

const SQL_ULTIMO_MOV = `
  SELECT m.* FROM (
    SELECT m.*, ROW_NUMBER() OVER (PARTITION BY id_contenedor ORDER BY fecha_movimiento DESC, id DESC) AS rn
    FROM movimiento_contenedor m
  ) m WHERE m.rn = 1
`

const AlquileresModel = {

  async listarPorEstado() {
    // Para calcular fechas de alquiler usamos el movimiento 'en_alquiler' (inicio del período)
    const SQL_MOV_ALQUILER = `
      SELECT DISTINCT ON (id_contenedor) id_contenedor, fecha_movimiento AS fecha_alquiler
      FROM movimiento_contenedor WHERE estado_paso = 'en_alquiler'
      ORDER BY id_contenedor, fecha_movimiento ASC
    `
    const baseSelect = `
      SELECT op.id, op.nro_op, op.nro_remito, op.estado, op.fecha_emision, op.fecha_entrega_planificada,
             cli.nombre AS cliente_nombre, cli.tel_whatsapp,
             oc.id AS id_op_contenedor, oc.domicilio_entrega, oc.zona_entrega,
             oc.plazo_alquiler, oc.precio_alquiler, oc.id_contenedor,
             cont.numero_contenedor,
             um.estado_paso AS contenedor_estado, um.fecha_movimiento AS fecha_ultimo_mov,
             ma.fecha_alquiler AS fecha_entrega_real,
             (COALESCE(LEFT(op.fecha_entrega_planificada, 10)::date, LEFT(ma.fecha_alquiler, 10)::date) + oc.plazo_alquiler) AS fecha_fin_estimada,
             ((COALESCE(LEFT(op.fecha_entrega_planificada, 10)::date, LEFT(ma.fecha_alquiler, 10)::date) + oc.plazo_alquiler) - CURRENT_DATE) AS dias_restantes,
             (CURRENT_DATE - LEFT(um.fecha_movimiento, 10)::date) AS dias_en_estado
      FROM op_encabezado op
      JOIN clientes cli ON cli.id = op.id_cliente
      LEFT JOIN op_detalle_contenedor oc ON oc.id_orden_pedido = op.id
      LEFT JOIN contenedores cont ON cont.id = oc.id_contenedor
      LEFT JOIN (${SQL_ULTIMO_MOV}) um ON um.id_contenedor = oc.id_contenedor
      LEFT JOIN (${SQL_MOV_ALQUILER}) ma ON ma.id_contenedor = oc.id_contenedor
      WHERE op.tipo_op = 'C'
    `
    const todosEnCurso = (await query(`${baseSelect}
      AND op.estado = 'entregado' AND um.estado_paso IN ('en_alquiler','pendiente_retiro')
      ORDER BY fecha_fin_estimada ASC`)).rows
    // "Por finalizar" son los que vencen hoy/mañana (o ya están en pendiente_retiro).
    const esPorFinalizar = a => a.contenedor_estado === 'pendiente_retiro'
      || (a.dias_restantes != null && a.dias_restantes <= 1)
    // Un mismo contenedor físico solo puede estar en un alquiler a la vez: si hay
    // varias ops activas para el mismo contenedor, dejamos una sola (la más urgente),
    // priorizando "por finalizar". Así no se duplica ni aparece en dos tablas.
    const masUrgente = (a, b) => {
      const pa = esPorFinalizar(a), pb = esPorFinalizar(b)
      if (pa !== pb) return pa // por finalizar gana
      return (a.dias_restantes ?? 9999) < (b.dias_restantes ?? 9999)
    }
    const porContenedor = new Map()
    for (const a of todosEnCurso) {
      const key = a.id_contenedor != null ? `c${a.id_contenedor}` : `op${a.id}`
      const prev = porContenedor.get(key)
      if (!prev || masUrgente(a, prev)) porContenedor.set(key, a)
    }
    const unicos = [...porContenedor.values()]
    const porFinalizar = unicos.filter(esPorFinalizar)
    const actuales     = unicos.filter(a => !esPorFinalizar(a))
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
        WHERE id_contenedor = ? AND id_op_contenedor = ? AND estado_paso = 'en_alquiler'
        ORDER BY fecha_movimiento ASC LIMIT 1
      `, [op.detalle.id_contenedor, op.detalle.id])).rows[0]
      op.diasEnDomicilio = movEntrega
        ? Math.floor((Date.now() - new Date(movEntrega.fecha_movimiento).getTime()) / 86400000)
        : null
      // Fin de alquiler = fecha de inicio (la que se edita) + plazo (días).
      // Base: fecha_entrega_planificada (inicio editable); si falta, la entrega real.
      const baseInicio = (op.fecha_entrega_planificada && String(op.fecha_entrega_planificada).slice(0, 10))
        || (movEntrega && String(movEntrega.fecha_movimiento).slice(0, 10))
      if (baseInicio) {
        const ini = new Date(baseInicio + 'T00:00:00')
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

  async crear({ id_cliente, id_administrativo, domicilio_entrega, domicilio_calle, domicilio_numero, zona_entrega, plazo_alquiler, precio_alquiler, id_contenedor, metodo_pago, observaciones, fecha_entrega_planificada, hora_planificada, id_chofer, id_camion }) {
    if (id_contenedor) {
      const noDisponible = (await query(`
        SELECT 1 FROM (
          SELECT DISTINCT ON (id_contenedor) id_contenedor, estado_paso
          FROM movimiento_contenedor ORDER BY id_contenedor, fecha_movimiento DESC, id DESC
        ) lm WHERE lm.id_contenedor = ? AND lm.estado_paso != 'disponible'
      `, [id_contenedor])).rows[0]
      if (noDisponible) throw new Error('El contenedor seleccionado ya no está disponible.')
    }
    const { nro }     = (await query(`SELECT COALESCE(MAX(nro_op), 0) + 1 AS nro FROM op_encabezado`)).rows[0]
    const { nro_rem } = (await query(`SELECT COALESCE(MAX(nro_remito), 0) + 1 AS nro_rem FROM op_encabezado`)).rows[0]
    return await transaction(async (q) => {
      const { rows } = await q(`INSERT INTO op_encabezado (id_cliente, id_administrativo, tipo_op, nro_op, nro_remito, estado, metodo_pago, observaciones, fecha_entrega_planificada, hora_planificada, id_chofer, id_camion) VALUES (?, ?, 'C', ?, ?, 'pendiente', ?, ?, ?, ?, ?, ?) RETURNING id`,
        [id_cliente, id_administrativo, nro, nro_rem, metodo_pago || null, observaciones || '', fecha_entrega_planificada || null, hora_planificada || null, id_chofer || null, id_camion || null])
      const id_op = rows[0].id
      const { rows: detRows } = await q(`INSERT INTO op_detalle_contenedor (id_orden_pedido, id_contenedor, domicilio_entrega, domicilio_calle, domicilio_numero, zona_entrega, plazo_alquiler, precio_alquiler, metodo_pago) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        [id_op, id_contenedor || null,
         domicilio_entrega || '', domicilio_calle || null, domicilio_numero || null,
         zona_entrega || '', parseInt(plazo_alquiler) || 5, parseFloat(precio_alquiler) || 0,
         metodo_pago || null])
      if (id_contenedor) {
        await q(`INSERT INTO movimiento_contenedor (id_contenedor, id_op_contenedor, estado_paso, observaciones) VALUES (?, ?, 'pendiente_despacho', 'Contenedor reservado para despacho')`,
          [id_contenedor, detRows[0].id])
      }
      return { id: id_op, nro_op: nro, nro_remito: nro_rem }
    })
  },

  async asignarContenedor(id_op, id_contenedor) {
    const oc = (await query(`UPDATE op_detalle_contenedor SET id_contenedor = ? WHERE id_orden_pedido = ? RETURNING id`, [id_contenedor, id_op])).rows[0]
    if (oc) {
      await query(`INSERT INTO movimiento_contenedor (id_contenedor, id_op_contenedor, estado_paso, observaciones) VALUES (?, ?, 'pendiente_despacho', 'Contenedor asignado — pendiente de despacho')`,
        [id_contenedor, oc.id])
    }
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
      await q(`INSERT INTO movimiento_contenedor (id_contenedor, id_op_contenedor, estado_paso, observaciones) VALUES (?, ?, 'despachado', 'Salida a entregar')`,
        [oc.id_contenedor, oc.id])
    })
    await FlotaModel.setEnUso(await FlotaModel.camionDeOperacion(id_op), true)
  },

  async entregar(id_op) {
    const oc = (await query(`SELECT id, id_contenedor FROM op_detalle_contenedor WHERE id_orden_pedido = ? LIMIT 1`, [id_op])).rows[0]
    if (!oc?.id_contenedor) throw new Error('No hay contenedor asignado.')
    await transaction(async (q) => {
      await q(`UPDATE op_encabezado SET estado = 'entregado' WHERE id = ? AND estado IN ('pendiente','despachado')`, [id_op])
      await q(`INSERT INTO movimiento_contenedor (id_contenedor, id_op_contenedor, estado_paso, observaciones) VALUES (?, ?, 'en_alquiler', 'Contenedor en domicilio — alquiler iniciado')`,
        [oc.id_contenedor, oc.id])
    })
    await FlotaModel.setEnUso(await FlotaModel.camionDeOperacion(id_op), false)
  },

  // Admin marca que el contenedor está listo para retirar (espera al chofer)
  async registrarRetiro(id_op) {
    const oc = (await query(`SELECT id, id_contenedor FROM op_detalle_contenedor WHERE id_orden_pedido = ? LIMIT 1`, [id_op])).rows[0]
    if (!oc?.id_contenedor) throw new Error('No hay contenedor asignado.')
    await query(`INSERT INTO movimiento_contenedor (id_contenedor, id_op_contenedor, estado_paso, observaciones) VALUES (?, ?, 'pendiente_retiro', 'Pendiente retiro por el chofer')`,
      [oc.id_contenedor, oc.id])
  },

  // Chofer inicia el retiro: sale a buscar el contenedor
  async iniciarRetiro(id_op) {
    const oc = (await query(`SELECT id, id_contenedor FROM op_detalle_contenedor WHERE id_orden_pedido = ? LIMIT 1`, [id_op])).rows[0]
    if (!oc?.id_contenedor) throw new Error('No hay contenedor asignado.')
    await query(`INSERT INTO movimiento_contenedor (id_contenedor, id_op_contenedor, estado_paso, observaciones) VALUES (?, ?, 'vuelta_a_planta', 'Retiro iniciado — volviendo a planta')`,
      [oc.id_contenedor, oc.id])
    await FlotaModel.setEnUso(await FlotaModel.camionDeOperacion(id_op), true)
  },

  async devolverAPlanta(id_op) {
    const oc = (await query(`SELECT id, id_contenedor FROM op_detalle_contenedor WHERE id_orden_pedido = ? LIMIT 1`, [id_op])).rows[0]
    if (!oc?.id_contenedor) throw new Error('No hay contenedor asignado.')
    await query(`INSERT INTO movimiento_contenedor (id_contenedor, id_op_contenedor, estado_paso, observaciones) VALUES (?, ?, 'disponible', 'Devuelto a planta — disponible')`,
      [oc.id_contenedor, oc.id])
    await FlotaModel.setEnUso(await FlotaModel.camionDeOperacion(id_op), false)
  },

  // ¿La operación (retiro) tiene un alquiler programado siguiente para el mismo contenedor?
  async proximoAlquiler(id_op) {
    const oc = (await query(`SELECT alquiler_siguiente_id FROM op_detalle_contenedor WHERE id_orden_pedido = ? LIMIT 1`, [id_op])).rows[0]
    if (!oc?.alquiler_siguiente_id) return null
    return (await query(`
      SELECT op.id, op.nro_op, cli.nombre AS cliente_nombre, oc.domicilio_entrega
      FROM op_encabezado op
      JOIN clientes cli ON cli.id = op.id_cliente
      LEFT JOIN op_detalle_contenedor oc ON oc.id_orden_pedido = op.id
      WHERE op.id = ? AND op.estado != 'anulado'
    `, [oc.alquiler_siguiente_id])).rows[0] || null
  },

  // El chofer retira el contenedor y, en vez de volver a planta, lo lleva
  // directo al próximo alquiler programado (se despacha con el mismo camión/chofer).
  async iniciarProximoAlquiler(id_op) {
    const ocA = (await query(`SELECT id, id_contenedor, alquiler_siguiente_id FROM op_detalle_contenedor WHERE id_orden_pedido = ? LIMIT 1`, [id_op])).rows[0]
    if (!ocA?.id_contenedor) throw new Error('No hay contenedor asignado.')
    if (!ocA.alquiler_siguiente_id) throw new Error('No hay un alquiler programado siguiente.')
    const idB = ocA.alquiler_siguiente_id
    const opA = (await query(`SELECT id_chofer, id_camion FROM op_encabezado WHERE id = ?`, [id_op])).rows[0]
    return await transaction(async (q) => {
      // El contenedor lo lleva el chofer que hizo el retiro: se le asigna la op siguiente.
      await q(`
        UPDATE op_encabezado
        SET estado = 'despachado', estado_programacion = 'activo',
            id_chofer = COALESCE(?, id_chofer), id_camion = COALESCE(?, id_camion)
        WHERE id = ? AND estado IN ('pendiente','despachado')
      `, [opA?.id_chofer || null, opA?.id_camion || null, idB])
      const ocB = (await q(`SELECT id, id_contenedor FROM op_detalle_contenedor WHERE id_orden_pedido = ? LIMIT 1`, [idB])).rows[0]
      if (!ocB) throw new Error('El alquiler siguiente no tiene detalle de contenedor.')
      if (!ocB.id_contenedor) {
        await q(`UPDATE op_detalle_contenedor SET id_contenedor = ? WHERE id = ?`, [ocA.id_contenedor, ocB.id])
        ocB.id_contenedor = ocA.id_contenedor
      }
      // El contenedor pasa directo a "despachado" (en camino) para el próximo alquiler.
      await q(`INSERT INTO movimiento_contenedor (id_contenedor, id_op_contenedor, estado_paso, observaciones) VALUES (?, ?, 'despachado', 'Retirado del cliente anterior — en camino al próximo alquiler')`,
        [ocB.id_contenedor, ocB.id])
      return idB
    })
  },

  async anular(id_op) {
    const oc = (await query(`SELECT id, id_contenedor FROM op_detalle_contenedor WHERE id_orden_pedido = ? LIMIT 1`, [id_op])).rows[0]
    await query(`UPDATE op_encabezado SET estado = 'anulado' WHERE id = ? AND estado IN ('pendiente','despachado')`, [id_op])
    if (oc?.id_contenedor) {
      const ec = (await query(`SELECT estado_paso FROM movimiento_contenedor WHERE id_contenedor = ? ORDER BY fecha_movimiento DESC, id DESC LIMIT 1`, [oc.id_contenedor])).rows[0]?.estado_paso
      if (ec && ['pendiente_despacho','despachado'].includes(ec)) {
        await query(`INSERT INTO movimiento_contenedor (id_contenedor, id_op_contenedor, estado_paso, observaciones) VALUES (?, ?, 'disponible', 'Alquiler anulado — contenedor disponible')`,
          [oc.id_contenedor, oc.id])
      }
    }
  },

  async clientes() {
    return (await query(`SELECT id, nombre FROM clientes WHERE activo = 1 ORDER BY nombre`)).rows
  },

  async contenedoresDisponibles() {
    // Un contenedor está disponible solo cuando su último movimiento es 'disponible'.
    const disponibles = (await query(`
      SELECT c.id, c.numero_contenedor FROM contenedores c
      JOIN (${SQL_ULTIMO_MOV}) um ON um.id_contenedor = c.id
      WHERE c.activo = 1 AND c.estado_general = 'operativo'
        AND um.estado_paso = 'disponible'
      ORDER BY c.numero_contenedor
    `)).rows

    const porLiberar = (await query(`
      SELECT c.id, c.numero_contenedor,
             op.id AS alquiler_actual_id, op.nro_op,
             cli.nombre AS cliente_actual,
             oc.plazo_alquiler,
             to_char(LEFT(ma.fecha_alquiler, 10)::date + oc.plazo_alquiler, 'YYYY-MM-DD') AS fecha_liberacion,
             ((LEFT(ma.fecha_alquiler, 10)::date + oc.plazo_alquiler) - CURRENT_DATE) * 24 AS horas_restantes
      FROM contenedores c
      JOIN (${SQL_ULTIMO_MOV}) um ON um.id_contenedor = c.id
      JOIN op_detalle_contenedor oc ON oc.id_contenedor = c.id AND oc.id = um.id_op_contenedor
      JOIN op_encabezado op ON op.id = oc.id_orden_pedido
      JOIN clientes cli ON cli.id = op.id_cliente
      JOIN (
        SELECT DISTINCT ON (id_contenedor) id_contenedor, fecha_movimiento AS fecha_alquiler
        FROM movimiento_contenedor WHERE estado_paso = 'en_alquiler'
        ORDER BY id_contenedor, fecha_movimiento ASC
      ) ma ON ma.id_contenedor = c.id
      WHERE c.activo = 1
        AND c.estado_general = 'operativo'
        AND um.estado_paso IN ('en_alquiler','pendiente_retiro')
        AND ((LEFT(ma.fecha_alquiler, 10)::date + oc.plazo_alquiler) - CURRENT_DATE) BETWEEN 0 AND 2
        AND oc.alquiler_siguiente_id IS NULL
      ORDER BY horas_restantes ASC
    `)).rows

    return { disponibles, porLiberar }
  },

  async crearProgramado({ id_cliente, id_administrativo, domicilio_entrega, domicilio_calle, domicilio_numero, zona_entrega, plazo_alquiler, precio_alquiler, id_contenedor, metodo_pago, observaciones, alquiler_actual_id, fecha_entrega_planificada, hora_planificada }) {
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
        INSERT INTO op_encabezado (id_cliente, id_administrativo, tipo_op, nro_op, nro_remito, estado, estado_programacion, metodo_pago, observaciones, fecha_entrega_planificada, hora_planificada)
        VALUES (?, ?, 'C', ?, ?, 'pendiente', 'programado', ?, ?, ?, ?)
        RETURNING id
      `, [id_cliente, id_administrativo, nro, nro_rem, metodo_pago || null, observaciones || '', fecha_entrega_planificada || null, hora_planificada || null])
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
    const oc = (await query(`SELECT id, id_contenedor FROM op_detalle_contenedor WHERE id_orden_pedido = ? LIMIT 1`, [id_op])).rows[0]
    if (oc?.id_contenedor) {
      await query(`INSERT INTO movimiento_contenedor (id_contenedor, id_op_contenedor, estado_paso, observaciones) VALUES (?, ?, 'pendiente_despacho', 'Alquiler programado activado — pendiente despacho')`,
        [oc.id_contenedor, oc.id])
    }
  },
}

module.exports = AlquileresModel
