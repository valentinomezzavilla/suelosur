'use strict'
const crypto = require('crypto')
const db = require('../config/db')

const SQL_ULTIMO_MOV_MAQ = `
  SELECT m.* FROM (
    SELECT m.*, ROW_NUMBER() OVER (PARTITION BY id_maquinaria ORDER BY fecha_movimiento DESC, rowid DESC) AS rn
    FROM movimiento_maquinaria m
  ) m WHERE m.rn = 1
`

const AlquileresMaquinariaModel = {

  listarPorEstado() {
    const baseSelect = `
      SELECT op.id, op.nro_op, op.nro_remito, op.estado, op.fecha_emision, op.fecha_entrega_planificada,
             cli.nombre AS cliente_nombre, cli.tel_whatsapp,
             opm.id AS id_op_maquinaria, opm.domicilio_entrega, opm.zona_entrega,
             opm.plazo_alquiler, opm.precio_total, opm.horas_pactadas, opm.id_maquinaria,
             maq.nombre AS maquinaria_nombre, maq.tipo AS maquinaria_tipo,
             um.estado_paso AS maquinaria_estado, um.fecha_movimiento AS fecha_entrega_real,
             date(substr(um.fecha_movimiento,1,10), '+' || opm.plazo_alquiler || ' days') AS fecha_fin_estimada,
             CAST(julianday(date(substr(um.fecha_movimiento,1,10), '+' || opm.plazo_alquiler || ' days')) - julianday('now') AS INTEGER) AS dias_restantes,
             CAST((julianday('now') - julianday(um.fecha_movimiento)) AS INTEGER) AS dias_en_estado
      FROM op_encabezado op
      JOIN clientes cli ON cli.id = op.id_cliente
      LEFT JOIN op_detalle_maquinaria opm ON opm.id_orden_pedido = op.id
      LEFT JOIN maquinaria maq ON maq.id = opm.id_maquinaria
      LEFT JOIN (${SQL_ULTIMO_MOV_MAQ}) um ON um.id_maquinaria = opm.id_maquinaria
      WHERE op.tipo_op = 'MA'
    `
    const actuales = db.prepare(`${baseSelect}
      AND op.estado = 'entregado' AND um.estado_paso IN ('en_uso','a_retirar')
      ORDER BY fecha_fin_estimada ASC`).all()
    const porFinalizar = actuales.filter(a => a.dias_restantes != null && a.dias_restantes <= 1)
    const programados  = db.prepare(`${baseSelect}
      AND op.estado IN ('pendiente','despachado')
      ORDER BY op.fecha_entrega_planificada ASC NULLS LAST`).all()
    return { actuales, porFinalizar, programados }
  },

  obtener(id) {
    const op = db.prepare(`
      SELECT op.*, cli.nombre AS cliente_nombre, cli.tel_whatsapp,
             u.nombre AS administrativo_nombre
      FROM op_encabezado op
      JOIN clientes cli ON cli.id = op.id_cliente
      JOIN users    u   ON u.id  = op.id_administrativo
      WHERE op.id = ? AND op.tipo_op = 'MA'
    `).get(id)
    if (!op) return null

    op.detalle = db.prepare(`
      SELECT opm.*, maq.nombre AS maquinaria_nombre, maq.tipo AS maquinaria_tipo, maq.estado_general
      FROM op_detalle_maquinaria opm LEFT JOIN maquinaria maq ON maq.id = opm.id_maquinaria
      WHERE opm.id_orden_pedido = ? LIMIT 1
    `).get(id)

    if (op.detalle?.id_maquinaria) {
      op.movimientos = db.prepare(`
        SELECT mv.*, u.nombre AS operario_nombre, f.patente AS camion_patente
        FROM movimiento_maquinaria mv
        LEFT JOIN users u ON u.id = mv.id_operario
        LEFT JOIN flota_vehiculos f ON f.id = mv.id_camion
        WHERE mv.id_maquinaria = ? AND mv.id_op_maquinaria = ?
        ORDER BY mv.fecha_movimiento ASC
      `).all(op.detalle.id_maquinaria, op.detalle.id)

      op.estadoMaquinaria = db.prepare(`
        SELECT estado_paso, fecha_movimiento FROM movimiento_maquinaria
        WHERE id_maquinaria = ? ORDER BY fecha_movimiento DESC, rowid DESC LIMIT 1
      `).get(op.detalle.id_maquinaria)
    } else {
      op.movimientos = []; op.estadoMaquinaria = null
    }
    return op
  },

  crear({ id_cliente, id_administrativo, domicilio_entrega, domicilio_calle, domicilio_numero, zona_entrega, plazo_alquiler, precio_por_hora, horas_pactadas, precio_total, id_maquinaria, id_chofer, metodo_pago, observaciones }) {
    const { nro }     = db.prepare(`SELECT COALESCE(MAX(nro_op), 0) + 1 AS nro FROM op_encabezado`).get()
    const { nro_rem } = db.prepare(`SELECT COALESCE(MAX(nro_remito), 0) + 1 AS nro_rem FROM op_encabezado`).get()
    const id_op = crypto.randomUUID()
    db.transaction(() => {
      db.prepare(`INSERT INTO op_encabezado (id, id_cliente, id_administrativo, tipo_op, nro_op, nro_remito, estado, metodo_pago, observaciones) VALUES (?, ?, ?, 'MA', ?, ?, 'pendiente', ?, ?)`
      ).run(id_op, id_cliente, id_administrativo, nro, nro_rem, metodo_pago || null, observaciones || '')
      db.prepare(`
        INSERT INTO op_detalle_maquinaria (id, id_orden_pedido, id_maquinaria, id_chofer, domicilio_entrega, domicilio_calle, domicilio_numero, zona_entrega, plazo_alquiler, precio_por_hora, horas_pactadas, precio_total, metodo_pago)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(crypto.randomUUID(), id_op, id_maquinaria || null, id_chofer || null,
             domicilio_entrega || '', domicilio_calle || null, domicilio_numero || null,
             zona_entrega || '', parseInt(plazo_alquiler) || 1,
             parseFloat(precio_por_hora) || 0, parseFloat(horas_pactadas) || 0,
             parseFloat(precio_total) || 0, metodo_pago || null)
    })()
    return { id: id_op, nro_op: nro, nro_remito: nro_rem }
  },

  asignarMaquinaria(id_op, id_maquinaria) {
    db.prepare(`UPDATE op_detalle_maquinaria SET id_maquinaria = ? WHERE id_orden_pedido = ?`).run(id_maquinaria, id_op)
  },

  // Edición de los datos comerciales / de trabajo del alquiler de maquinaria
  actualizar(id_op, { calle, numero, zona_entrega, plazo_alquiler, precio_por_hora, horas_pactadas, precio_total, metodo_pago, observaciones, fecha_entrega_planificada }) {
    const domicilio_entrega = `${calle || ''} ${numero || ''}`.trim()
    db.transaction(() => {
      db.prepare(`UPDATE op_encabezado SET observaciones = ?, metodo_pago = ?, fecha_entrega_planificada = ? WHERE id = ?`)
        .run(observaciones || '', metodo_pago || null, fecha_entrega_planificada || null, id_op)
      db.prepare(`
        UPDATE op_detalle_maquinaria
        SET domicilio_entrega = ?, domicilio_calle = ?, domicilio_numero = ?, zona_entrega = ?,
            plazo_alquiler = ?, precio_por_hora = ?, horas_pactadas = ?, precio_total = ?, metodo_pago = ?
        WHERE id_orden_pedido = ?
      `).run(domicilio_entrega, calle || null, numero || null, zona_entrega || '',
             parseInt(plazo_alquiler) || 1, parseFloat(precio_por_hora) || 0,
             parseFloat(horas_pactadas) || 0, parseFloat(precio_total) || 0, metodo_pago || null, id_op)
    })()
  },

  despachar(id_op) {
    const opm = db.prepare(`SELECT id, id_maquinaria FROM op_detalle_maquinaria WHERE id_orden_pedido = ? LIMIT 1`).get(id_op)
    if (!opm?.id_maquinaria) throw new Error('No hay maquinaria asignada.')
    db.transaction(() => {
      db.prepare(`UPDATE op_encabezado SET estado = 'despachado' WHERE id = ? AND estado = 'pendiente'`).run(id_op)
      db.prepare(`INSERT INTO movimiento_maquinaria (id, id_maquinaria, id_op_maquinaria, estado_paso, observaciones) VALUES (?, ?, ?, 'despachada', 'Salida a trabajo')`
      ).run(crypto.randomUUID(), opm.id_maquinaria, opm.id)
    })()
  },

  entregar(id_op) {
    const opm = db.prepare(`SELECT id, id_maquinaria FROM op_detalle_maquinaria WHERE id_orden_pedido = ? LIMIT 1`).get(id_op)
    if (!opm?.id_maquinaria) throw new Error('No hay maquinaria asignada.')
    db.transaction(() => {
      db.prepare(`UPDATE op_encabezado SET estado = 'entregado' WHERE id = ? AND estado IN ('pendiente','despachado')`).run(id_op)
      db.prepare(`INSERT INTO movimiento_maquinaria (id, id_maquinaria, id_op_maquinaria, estado_paso, observaciones) VALUES (?, ?, ?, 'en_uso', 'En trabajo en domicilio')`
      ).run(crypto.randomUUID(), opm.id_maquinaria, opm.id)
    })()
  },

  registrarRetiro(id_op) {
    const opm = db.prepare(`SELECT id, id_maquinaria FROM op_detalle_maquinaria WHERE id_orden_pedido = ? LIMIT 1`).get(id_op)
    if (!opm?.id_maquinaria) throw new Error('No hay maquinaria asignada.')
    db.prepare(`INSERT INTO movimiento_maquinaria (id, id_maquinaria, id_op_maquinaria, estado_paso, observaciones) VALUES (?, ?, ?, 'a_retirar', 'Trabajo finalizado, pendiente retiro')`
    ).run(crypto.randomUUID(), opm.id_maquinaria, opm.id)
  },

  devolverAPlanta(id_op) {
    const opm = db.prepare(`SELECT id, id_maquinaria FROM op_detalle_maquinaria WHERE id_orden_pedido = ? LIMIT 1`).get(id_op)
    if (!opm?.id_maquinaria) throw new Error('No hay maquinaria asignada.')
    db.prepare(`INSERT INTO movimiento_maquinaria (id, id_maquinaria, id_op_maquinaria, estado_paso, observaciones) VALUES (?, ?, ?, 'en_planta', 'Devuelta a planta')`
    ).run(crypto.randomUUID(), opm.id_maquinaria, opm.id)
  },

  anular(id_op) {
    db.prepare(`UPDATE op_encabezado SET estado = 'anulado' WHERE id = ? AND estado IN ('pendiente','despachado')`).run(id_op)
  },
}

module.exports = AlquileresMaquinariaModel
