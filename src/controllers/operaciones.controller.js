'use strict'
const { query } = require('../config/db')
const OperacionesModel = require('../models/operaciones.model')
const { linkWhatsApp } = require('../utils/whatsapp')
const { fmtFecha } = require('../utils/fecha')

const TIPO_OP_LABEL = { M: 'Material', C: 'Contenedor', MA: 'Maquinaria' }
const MODALIDAD_LABEL = { deposito: 'Retira en depósito', flete: 'Con flete (entrega)' }

// Arma el texto del viaje para el chofer (WhatsApp). Solo incluye lo que tenga dato.
// Sin emojis a propósito: el traspaso navegador → WhatsApp (sobre todo en Windows)
// corrompe los caracteres de 4 bytes (emojis) y se ven como "◇". Los caracteres
// de 2–3 bytes (tildes, —, ·, ³) sí se transmiten bien, así que el mensaje usa
// negrita de WhatsApp (*...*) y etiquetas de texto para quedar prolijo y confiable.
function construirMensajeViaje(op, materiales, linkIniciar) {
  const l = []
  l.push('*SUELOSUR — Viaje asignado*')
  l.push('')
  const nombreChofer = (op.chofer_nombre || '').trim()
  if (nombreChofer) { l.push(`Hola ${nombreChofer}, tenés un viaje asignado:`); l.push('') }
  l.push(`*OP #${op.nro_op}*${op.tipo_op ? ' · ' + (TIPO_OP_LABEL[op.tipo_op] || op.tipo_op) : ''}`)
  if (op.cliente && op.cliente.trim()) l.push(`Cliente: ${op.cliente.trim()}`)

  const cuando = [fmtFecha(op.fecha_entrega_planificada), (op.hora_planificada || '').slice(0, 5)].filter(Boolean).join(' ')
  if (cuando) l.push(`Fecha: ${cuando}`)

  const dom = []
  if (op.domicilio_calle) dom.push(op.domicilio_calle + (op.domicilio_sin_numero ? ' S/N' : (op.domicilio_altura ? ' ' + op.domicilio_altura : '')))
  if (op.zona) dom.push(op.zona)
  if (dom.length) l.push(`Dirección: ${dom.join(', ')}`)
  if (op.obra && op.obra.trim()) l.push(`Obra: ${op.obra.trim()}`)

  if (op.modalidad) l.push(`Modalidad: ${MODALIDAD_LABEL[op.modalidad] || op.modalidad}`)

  if (materiales && materiales.length) {
    l.push('Materiales:')
    materiales.forEach(m => l.push(`  - ${m.cantidad_pedida} ${m.unidad_medida || ''} ${m.producto}`.replace(/\s+/g, ' ').trimEnd()))
  }
  if (op.camion_label && op.camion_label.trim()) l.push(`Camión: ${op.camion_label.trim()}`)
  if (op.observaciones && op.observaciones.trim()) l.push(`Obs: ${op.observaciones.trim()}`)

  // Link para iniciar el viaje desde la app (abre confirmación y registra el inicio).
  if (linkIniciar) {
    l.push('')
    l.push('Para iniciar el viaje, abrí este link y confirmá:')
    l.push(linkIniciar)
  }
  return l.join('\n')
}

const OperacionesController = {
  async asignarRecursos(req, res) {
    try {
      const opId = req.params.id
      const { advertencias } = await OperacionesModel.asignar(opId, {
        id_chofer: req.body.id_chofer || null,
        id_camion: req.body.id_camion || null,
        usuario: req.session.user?.id,
      })
      req.flash('success', 'Recursos asignados a la operación.')
      if (advertencias?.length) {
        req.session.solapamiento = { opId: String(opId), advertencias }
      } else {
        delete req.session.solapamiento
      }
    } catch (err) {
      console.error(err); req.flash('error', err.message || 'Error al asignar recursos.')
    }
    res.redirect(req.get('Referrer') || '/ventas')
  },

  // Genera el link wa.me con el detalle del viaje y redirige a WhatsApp.
  // El admin/dueño solo presiona "Enviar" en WhatsApp (no se envía solo).
  async whatsappChofer(req, res) {
    const back = req.get('Referrer') || '/ventas'
    try {
      const opId = req.params.id
      const op = (await query(`
        SELECT op.nro_op, op.tipo_op, op.modalidad, op.observaciones, op.obra,
               op.fecha_entrega_planificada, op.hora_planificada,
               op.domicilio_calle, op.domicilio_altura, op.domicilio_sin_numero, op.zona,
               NULLIF(TRIM(COALESCE(c.nombre,'') || ' ' || COALESCE(c.apellido,'')), '') AS cliente,
               NULLIF(TRIM(COALESCE(e.nombre,'') || ' ' || COALESCE(e.apellido,'')), '') AS chofer_nombre,
               e.telefono AS chofer_telefono,
               (COALESCE(v.nombre,'') || CASE WHEN v.patente IS NOT NULL THEN ' (' || v.patente || ')' ELSE '' END) AS camion_label
        FROM op_encabezado op
        LEFT JOIN clientes c        ON c.id = op.id_cliente
        LEFT JOIN empleados e       ON e.id = op.id_chofer
        LEFT JOIN flota_vehiculos v ON v.id = op.id_camion
        WHERE op.id = ?
      `, [opId])).rows[0]

      if (!op) { req.flash('error', 'Operación no encontrada.'); return res.redirect(back) }
      if (!op.chofer_telefono) {
        req.flash('error', 'El chofer no tiene teléfono cargado. Cargalo en su ficha para poder enviarle el viaje por WhatsApp.')
        return res.redirect(back)
      }

      const materiales = (await query(`
        SELECT d.cantidad_pedida, p.nombre AS producto, p.unidad_medida
        FROM op_detalle_material d JOIN productos p ON p.id = d.id_producto
        WHERE d.id_orden_pedido = ?
      `, [opId])).rows

      // Link "Iniciar viaje" (deep-link a la app) solo para tareas del chofer: viaje (M) y contenedor (C).
      const base = process.env.APP_URL || `${req.protocol}://${req.get('host')}`
      const linkIniciar = ['M', 'C'].includes(op.tipo_op) ? `${base}/hoja-de-ruta/${opId}/iniciar` : null

      const link = linkWhatsApp(op.chofer_telefono, construirMensajeViaje(op, materiales, linkIniciar))
      if (!link) {
        req.flash('error', 'El teléfono del chofer no es válido para WhatsApp.')
        return res.redirect(back)
      }
      return res.redirect(link)
    } catch (err) {
      console.error(err); req.flash('error', 'No se pudo generar el mensaje de WhatsApp.')
      return res.redirect(back)
    }
  },

  async retrasar30(req, res) {
    try {
      const op = (await query(`SELECT hora_planificada FROM op_encabezado WHERE id = ?`, [req.params.id])).rows[0]
      if (!op?.hora_planificada) {
        req.flash('error', 'La operación no tiene hora planificada.')
        return res.redirect(req.get('Referrer') || '/')
      }
      const [h, m] = op.hora_planificada.split(':').map(Number)
      const totalMin = h * 60 + (m || 0) + 30
      const nueva = `${String(Math.floor(totalMin / 60) % 24).padStart(2, '0')}:${String(totalMin % 60).padStart(2, '0')}`
      await query(`UPDATE op_encabezado SET hora_planificada = ? WHERE id = ?`, [nueva, req.params.id])
      delete req.session.solapamiento
      req.flash('success', `Hora actualizada a ${nueva}. Verificá si sigue habiendo solapamiento.`)
    } catch (err) {
      console.error(err); req.flash('error', 'Error al retrasar la operación.')
    }
    res.redirect(req.get('Referrer') || '/')
  },
}

module.exports = OperacionesController
