'use strict'
const crypto = require('crypto')
const db = require('../config/db')

const SQL_ULTIMO_MOV = `
  SELECT m.* FROM (
    SELECT m.*, ROW_NUMBER() OVER (PARTITION BY id_contenedor ORDER BY fecha_movimiento DESC, rowid DESC) AS rn
    FROM movimiento_contenedor m
  ) m WHERE m.rn = 1
`

const AlquileresModel = {

  listarPorEstado() {
    const baseSelect = `
      SELECT op.id, op.nro_op, op.nro_remito, op.estado, op.fecha_emision, op.fecha_entrega_planificada,
             cli.nombre AS cliente_nombre, cli.tel_whatsapp,
             oc.id AS id_op_contenedor, oc.domicilio_entrega, oc.zona_entrega,
             oc.plazo_alquiler, oc.precio_alquiler, oc.id_contenedor,
             cont.numero_contenedor,
             um.estado_paso AS contenedor_estado, um.fecha_movimiento AS fecha_entrega_real,
             date(substr(um.fecha_movimiento,1,10), '+' || oc.plazo_alquiler || ' days') AS fecha_fin_estimada,
             CAST(julianday(date(substr(um.fecha_movimiento,1,10), '+' || oc.plazo_alquiler || ' days')) - julianday('now') AS INTEGER) AS dias_restantes,
             CAST((julianday('now') - julianday(um.fecha_movimiento)) AS INTEGER) AS dias_en_estado
      FROM op_encabezado op
      JOIN clientes cli ON cli.id = op.id_cliente
      LEFT JOIN op_detalle_contenedor oc ON oc.id_orden_pedido = op.id
      LEFT JOIN contenedores cont ON cont.id = oc.id_contenedor
      LEFT JOIN (${SQL_ULTIMO_MOV}) um ON um.id_contenedor = oc.id_contenedor
      WHERE op.tipo_op = 'C'
    `
    const actuales = db.prepare(`${baseSelect}
      AND op.estado = 'entregado' AND um.estado_paso IN ('entregado','en_alquiler','a_retirar')
      ORDER BY fecha_fin_estimada ASC`).all()
    const porFinalizar = actuales.filter(a => a.dias_restantes != null && a.dias_restantes <= 1)
    const programados  = db.prepare(`${baseSelect}
      AND op.estado IN ('pendiente','despachado')
      ORDER BY op.fecha_entrega_planificada ASC NULLS LAST, op.created_at ASC`).all()
    return { actuales, porFinalizar, programados }
  },

  obtener(id) {
    const op = db.prepare(`
      SELECT op.*, cli.nombre AS cliente_nombre, cli.tel_whatsapp, cli.domicilio_ppal,
             u.nombre AS administrativo_nombre
      FROM op_encabezado op
      JOIN clientes cli ON cli.id = op.id_cliente
      JOIN users    u   ON u.id  = op.id_administrativo
      WHERE op.id = ? AND op.tipo_op = 'C'
    `).get(id)
    if (!op) return null

    op.detalle = db.prepare(`
      SELECT oc.*, cont.numero_contenedor, cont.estado_general
      FROM op_detalle_contenedor oc LEFT JOIN contenedores cont ON cont.id = oc.id_contenedor
      WHERE oc.id_orden_pedido = ? LIMIT 1
    `).get(id)

    if (op.detalle?.id_contenedor) {
      op.movimientos = db.prepare(`
        SELECT m.*, u.nombre AS chofer_nombre, f.patente AS camion_patente
        FROM movimiento_contenedor m
        LEFT JOIN users u ON u.id = m.id_chofer
        LEFT JOIN flota_vehiculos f ON f.id = m.id_camion
        WHERE m.id_contenedor = ? AND m.id_op_contenedor = ?
        ORDER BY m.fecha_movimiento ASC, m.rowid ASC
      `).all(op.detalle.id_contenedor, op.detalle.id)

      op.estadoContenedor = db.prepare(`
        SELECT estado_paso, fecha_movimiento FROM movimiento_contenedor
        WHERE id_contenedor = ? ORDER BY fecha_movimiento DESC, rowid DESC LIMIT 1
      `).get(op.detalle.id_contenedor)

      const movEntrega = db.prepare(`
        SELECT fecha_movimiento FROM movimiento_contenedor
        WHERE id_contenedor = ? AND id_op_contenedor = ? AND estado_paso = 'entregado'
        ORDER BY fecha_movimiento ASC LIMIT 1
      `).get(op.detalle.id_contenedor, op.detalle.id)
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

  crear({ id_cliente, id_administrativo, domicilio_entrega, domicilio_calle, domicilio_numero, zona_entrega, plazo_alquiler, precio_alquiler, id_contenedor, metodo_pago, observaciones }) {
    if (id_contenedor) {
      const reservado = db.prepare(`
        SELECT 1 FROM op_detalle_contenedor oc
        JOIN op_encabezado op ON op.id = oc.id_orden_pedido
        LEFT JOIN (${SQL_ULTIMO_MOV}) lm ON lm.id_contenedor = oc.id_contenedor
        WHERE oc.id_contenedor = ? AND op.estado != 'anulado'
          AND (op.estado IN ('pendiente','despachado')
               OR (op.estado = 'entregado' AND lm.estado_paso IN ('en_transito','entregado','en_alquiler','a_retirar')))
      `).get(id_contenedor)
      if (reservado) throw new Error('El contenedor seleccionado ya no está disponible.')
    }
    const { nro }     = db.prepare(`SELECT COALESCE(MAX(nro_op), 0) + 1 AS nro FROM op_encabezado`).get()
    const { nro_rem } = db.prepare(`SELECT COALESCE(MAX(nro_remito), 0) + 1 AS nro_rem FROM op_encabezado`).get()
    const id_op = crypto.randomUUID()
    db.transaction(() => {
      db.prepare(`INSERT INTO op_encabezado (id, id_cliente, id_administrativo, tipo_op, nro_op, nro_remito, estado, metodo_pago, observaciones) VALUES (?, ?, ?, 'C', ?, ?, 'pendiente', ?, ?)`
      ).run(id_op, id_cliente, id_administrativo, nro, nro_rem, metodo_pago || null, observaciones || '')
      db.prepare(`INSERT INTO op_detalle_contenedor (id, id_orden_pedido, id_contenedor, domicilio_entrega, domicilio_calle, domicilio_numero, zona_entrega, plazo_alquiler, precio_alquiler, metodo_pago) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(crypto.randomUUID(), id_op, id_contenedor || null,
            domicilio_entrega || '', domicilio_calle || null, domicilio_numero || null,
            zona_entrega || '', parseInt(plazo_alquiler) || 5, parseFloat(precio_alquiler) || 0,
            metodo_pago || null)
    })()
    return { id: id_op, nro_op: nro, nro_remito: nro_rem }
  },

  asignarContenedor(id_op, id_contenedor) {
    db.prepare(`UPDATE op_detalle_contenedor SET id_contenedor = ? WHERE id_orden_pedido = ?`).run(id_contenedor, id_op)
  },

  // Edición de los datos comerciales / de entrega del alquiler
  actualizar(id_op, { calle, numero, zona_entrega, plazo_alquiler, precio_alquiler, metodo_pago, observaciones, fecha_entrega_planificada }) {
    const domicilio_entrega = `${calle || ''} ${numero || ''}`.trim()
    db.transaction(() => {
      db.prepare(`UPDATE op_encabezado SET observaciones = ?, metodo_pago = ?, fecha_entrega_planificada = ? WHERE id = ?`)
        .run(observaciones || '', metodo_pago || null, fecha_entrega_planificada || null, id_op)
      db.prepare(`
        UPDATE op_detalle_contenedor
        SET domicilio_entrega = ?, domicilio_calle = ?, domicilio_numero = ?, zona_entrega = ?,
            plazo_alquiler = ?, precio_alquiler = ?, metodo_pago = ?
        WHERE id_orden_pedido = ?
      `).run(domicilio_entrega, calle || null, numero || null, zona_entrega || '',
             parseInt(plazo_alquiler) || 5, parseFloat(precio_alquiler) || 0, metodo_pago || null, id_op)
    })()
  },

  despachar(id_op) {
    const oc = db.prepare(`SELECT id, id_contenedor FROM op_detalle_contenedor WHERE id_orden_pedido = ? LIMIT 1`).get(id_op)
    if (!oc?.id_contenedor) throw new Error('No hay contenedor asignado.')
    db.transaction(() => {
      db.prepare(`UPDATE op_encabezado SET estado = 'despachado' WHERE id = ? AND estado = 'pendiente'`).run(id_op)
      db.prepare(`INSERT INTO movimiento_contenedor (id, id_contenedor, id_op_contenedor, estado_paso, observaciones) VALUES (?, ?, ?, 'en_transito', 'Salida a entregar')`
      ).run(crypto.randomUUID(), oc.id_contenedor, oc.id)
    })()
  },

  entregar(id_op) {
    const oc = db.prepare(`SELECT id, id_contenedor FROM op_detalle_contenedor WHERE id_orden_pedido = ? LIMIT 1`).get(id_op)
    if (!oc?.id_contenedor) throw new Error('No hay contenedor asignado.')
    db.transaction(() => {
      db.prepare(`UPDATE op_encabezado SET estado = 'entregado' WHERE id = ? AND estado IN ('pendiente','despachado')`).run(id_op)
      db.prepare(`INSERT INTO movimiento_contenedor (id, id_contenedor, id_op_contenedor, estado_paso, observaciones) VALUES (?, ?, ?, 'entregado', 'Entregado en domicilio')`
      ).run(crypto.randomUUID(), oc.id_contenedor, oc.id)
    })()
  },

  registrarRetiro(id_op) {
    const oc = db.prepare(`SELECT id, id_contenedor FROM op_detalle_contenedor WHERE id_orden_pedido = ? LIMIT 1`).get(id_op)
    if (!oc?.id_contenedor) throw new Error('No hay contenedor asignado.')
    db.prepare(`INSERT INTO movimiento_contenedor (id, id_contenedor, id_op_contenedor, estado_paso, observaciones) VALUES (?, ?, ?, 'en_transito', 'Retirado de domicilio')`
    ).run(crypto.randomUUID(), oc.id_contenedor, oc.id)
  },

  devolverAPlanta(id_op) {
    const oc = db.prepare(`SELECT id, id_contenedor FROM op_detalle_contenedor WHERE id_orden_pedido = ? LIMIT 1`).get(id_op)
    if (!oc?.id_contenedor) throw new Error('No hay contenedor asignado.')
    db.prepare(`INSERT INTO movimiento_contenedor (id, id_contenedor, id_op_contenedor, estado_paso, observaciones) VALUES (?, ?, ?, 'vaciado', 'Devuelto a planta')`
    ).run(crypto.randomUUID(), oc.id_contenedor, oc.id)
  },

  anular(id_op) {
    db.prepare(`UPDATE op_encabezado SET estado = 'anulado' WHERE id = ? AND estado IN ('pendiente','despachado')`).run(id_op)
  },

  clientes() {
    return db.prepare(`SELECT id, nombre FROM clientes WHERE activo = 1 ORDER BY nombre`).all()
  },

  contenedoresDisponibles() {
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

    const disponibles = db.prepare(`
      SELECT c.id, c.numero_contenedor FROM contenedores c
      JOIN (${SQL_ULTIMO_MOV}) um ON um.id_contenedor = c.id
      WHERE c.activo = 1 AND c.estado_general = 'operativo'
        AND um.estado_paso IN ('en_planta','vaciado')
        AND c.id NOT IN (${SQL_RESERVADOS})
      ORDER BY c.numero_contenedor
    `).all()

    const porLiberar = db.prepare(`
      SELECT c.id, c.numero_contenedor,
             op.id AS alquiler_actual_id, op.nro_op,
             cli.nombre AS cliente_actual,
             oc.plazo_alquiler,
             date(substr(um.fecha_movimiento,1,10), '+' || oc.plazo_alquiler || ' days') AS fecha_liberacion,
             CAST((julianday(date(substr(um.fecha_movimiento,1,10), '+' || oc.plazo_alquiler || ' days')) - julianday('now')) * 24 AS INTEGER) AS horas_restantes
      FROM contenedores c
      JOIN (${SQL_ULTIMO_MOV}) um ON um.id_contenedor = c.id
      JOIN op_detalle_contenedor oc ON oc.id_contenedor = c.id AND oc.id = um.id_op_contenedor
      JOIN op_encabezado op ON op.id = oc.id_orden_pedido
      JOIN clientes cli ON cli.id = op.id_cliente
      WHERE c.activo = 1
        AND c.estado_general = 'operativo'
        AND um.estado_paso IN ('entregado','en_alquiler','a_retirar')
        AND (julianday(date(substr(um.fecha_movimiento,1,10), '+' || oc.plazo_alquiler || ' days')) - julianday('now')) BETWEEN 0 AND 2
        AND oc.alquiler_siguiente_id IS NULL
      ORDER BY horas_restantes ASC
    `).all()

    return { disponibles, porLiberar }
  },

  crearProgramado({ id_cliente, id_administrativo, domicilio_entrega, domicilio_calle, domicilio_numero, zona_entrega, plazo_alquiler, precio_alquiler, id_contenedor, metodo_pago, observaciones, alquiler_actual_id }) {
    const tieneProximoAlquiler = db.prepare(`
      SELECT 1 FROM op_detalle_contenedor oc
      JOIN op_encabezado op ON op.id = oc.id_orden_pedido
      WHERE oc.id_contenedor = ? AND oc.alquiler_siguiente_id IS NOT NULL AND op.estado != 'anulado'
    `).get(id_contenedor)
    if (tieneProximoAlquiler) throw new Error('Este contenedor ya tiene un alquiler programado.')

    const { nro }     = db.prepare(`SELECT COALESCE(MAX(nro_op), 0) + 1 AS nro FROM op_encabezado`).get()
    const { nro_rem } = db.prepare(`SELECT COALESCE(MAX(nro_remito), 0) + 1 AS nro_rem FROM op_encabezado`).get()
    const id_op = crypto.randomUUID()
    const id_detalle = crypto.randomUUID()

    db.transaction(() => {
      db.prepare(`
        INSERT INTO op_encabezado (id, id_cliente, id_administrativo, tipo_op, nro_op, nro_remito, estado, estado_programacion, metodo_pago, observaciones)
        VALUES (?, ?, ?, 'C', ?, ?, 'pendiente', 'programado', ?, ?)
      `).run(id_op, id_cliente, id_administrativo, nro, nro_rem, metodo_pago || null, observaciones || '')

      db.prepare(`
        INSERT INTO op_detalle_contenedor (id, id_orden_pedido, id_contenedor, domicilio_entrega, domicilio_calle, domicilio_numero, zona_entrega, plazo_alquiler, precio_alquiler, metodo_pago)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id_detalle, id_op, id_contenedor, domicilio_entrega || '',
             domicilio_calle || null, domicilio_numero || null,
             zona_entrega || '', parseInt(plazo_alquiler) || 5, parseFloat(precio_alquiler) || 0,
             metodo_pago || null)

      db.prepare(`
        UPDATE op_detalle_contenedor SET alquiler_siguiente_id = ?
        WHERE id_orden_pedido = ? AND id_contenedor = ?
      `).run(id_op, alquiler_actual_id, id_contenedor)
    })()

    return { id: id_op, nro_op: nro, nro_remito: nro_rem }
  },

  activarProgramado(id_op) {
    const op = db.prepare(`SELECT estado_programacion FROM op_encabezado WHERE id = ?`).get(id_op)
    if (!op || op.estado_programacion !== 'programado') return
    db.prepare(`UPDATE op_encabezado SET estado_programacion = 'activo' WHERE id = ?`).run(id_op)
  },
}

module.exports = AlquileresModel
