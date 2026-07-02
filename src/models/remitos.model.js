'use strict'
// ─────────────────────────────────────────────────────────────────
// Remitos — capa única para cualquier operación (op_encabezado).
// Normaliza material (M), contenedor (C) y maquinaria (MA) a una
// misma forma para PDF / vista / remito firmado.
// ─────────────────────────────────────────────────────────────────
const { query, transaction } = require('../config/db')

const TIPO_LABEL = { M: 'Venta de áridos', C: 'Alquiler de contenedor', MA: 'Alquiler de maquinaria' }

const RemitosModel = {

  // Devuelve un objeto normalizado o null si la OP no existe.
  async obtener(opId) {
    const op = (await query(`
      SELECT op.*, COALESCE(c.nombre, 'Particular') AS cliente_nombre,
             c.apellido AS cliente_apellido, c.tel_whatsapp, c.telefono AS cliente_telefono,
             c.domicilio_ppal, c.dni AS cliente_dni,
             u.nombre AS administrativo_nombre
      FROM op_encabezado op
      LEFT JOIN clientes c ON c.id = op.id_cliente
      JOIN users u ON u.id = op.id_administrativo
      WHERE op.id = ?
    `, [opId])).rows[0]
    if (!op) return null

    const r = {
      id: op.id,
      tipo_op: op.tipo_op,
      tipoLabel: TIPO_LABEL[op.tipo_op] || op.tipo_op,
      nro_op: op.nro_op,
      nro_remito: op.nro_remito,
      fecha_emision: op.fecha_emision,
      estado: op.estado,
      modalidad: op.modalidad,
      metodo_pago: op.metodo_pago,
      observaciones: op.observaciones || '',
      archivo_remito: op.archivo_remito || null,
      firma_cliente: op.firma_cliente || null,
      firma_aclaracion: op.firma_aclaracion || '',
      archivo_remito_retiro: op.archivo_remito_retiro || null,
      firma_retiro: op.firma_retiro || null,
      firma_retiro_aclaracion: op.firma_retiro_aclaracion || '',
      cliente: {
        nombre: `${op.cliente_nombre || ''} ${op.cliente_apellido || ''}`.trim() || 'Particular',
        telefono: op.cliente_telefono || op.tel_whatsapp || '',
        dni: op.cliente_dni || '',
        domicilio: op.domicilio_ppal || '',
      },
      administrativo: op.administrativo_nombre || '',
      entrega: null,
      items: [],
      total: 0,
    }

    if (op.tipo_op === 'M') {
      const dets = (await query(`
        SELECT d.cantidad_pedida, d.precio_unitario, p.nombre AS producto, p.unidad_medida
        FROM op_detalle_material d JOIN productos p ON p.id = d.id_producto
        WHERE d.id_orden_pedido = ?
      `, [opId])).rows
      r.items = dets.map(d => ({
        descripcion: d.producto,
        unidad: d.unidad_medida,
        cantidad: d.cantidad_pedida,
        precioUnit: d.precio_unitario,
        subtotal: d.cantidad_pedida * d.precio_unitario,
      }))
      if (op.modalidad === 'flete') {
        const calle = [op.domicilio_calle, op.domicilio_altura].filter(Boolean).join(' ').trim()
        r.entrega = { domicilio: calle || op.domicilio_ppal || '', zona: '', plazo: null }
      }
    } else if (op.tipo_op === 'C') {
      const d = (await query(`
        SELECT oc.*, cont.numero_contenedor
        FROM op_detalle_contenedor oc LEFT JOIN contenedores cont ON cont.id = oc.id_contenedor
        WHERE oc.id_orden_pedido = ? LIMIT 1
      `, [opId])).rows[0]
      if (d) {
        r.items = [{
          descripcion: `Alquiler de contenedor de obra${d.numero_contenedor ? ' N° ' + d.numero_contenedor : ''}`,
          unidad: 'días', cantidad: d.plazo_alquiler, precioUnit: d.precio_alquiler || 0,
          subtotal: d.precio_alquiler || 0,
        }]
        r.entrega = {
          domicilio: d.domicilio_entrega || [d.domicilio_calle, d.domicilio_numero].filter(Boolean).join(' '),
          zona: d.zona_entrega || '', plazo: d.plazo_alquiler,
        }
      }
    } else if (op.tipo_op === 'MA') {
      const d = (await query(`
        SELECT opm.*, maq.nombre AS maquinaria_nombre
        FROM op_detalle_maquinaria opm LEFT JOIN maquinaria maq ON maq.id = opm.id_maquinaria
        WHERE opm.id_orden_pedido = ? LIMIT 1
      `, [opId])).rows[0]
      if (d) {
        r.items = [{
          descripcion: `Alquiler de maquinaria${d.maquinaria_nombre ? ' — ' + d.maquinaria_nombre : ''}`,
          unidad: d.horas_pactadas ? 'horas' : 'días',
          cantidad: d.horas_pactadas || d.plazo_alquiler,
          precioUnit: d.horas_pactadas ? (d.precio_por_hora || 0) : (d.precio_total || 0),
          subtotal: d.precio_total || 0,
        }]
        r.entrega = {
          domicilio: d.domicilio_entrega || [d.domicilio_calle, d.domicilio_numero].filter(Boolean).join(' '),
          zona: d.zona_entrega || '', plazo: d.plazo_alquiler,
        }
      }
    }

    r.total = r.items.reduce((s, i) => s + (i.subtotal || 0), 0)
    return r
  },

  async guardarArchivo(opId, filename, tipo = 'entrega') {
    const col = tipo === 'retiro' ? 'archivo_remito_retiro' : 'archivo_remito'
    await query(`UPDATE op_encabezado SET ${col} = ? WHERE id = ?`, [filename, opId])
  },

  // Convierte un remito normalizado a su "vista de retiro": usa la firma/foto del
  // retiro y ajusta la etiqueta. Devuelve un nuevo objeto (no muta el original).
  vistaRetiro(r) {
    return {
      ...r,
      esRetiro: true,
      tipoLabel: 'Remito de retiro — contenedor',
      firma_cliente: r.firma_retiro,
      firma_aclaracion: r.firma_retiro_aclaracion,
      archivo_remito: r.archivo_remito_retiro,
    }
  },

  // Ruta de "volver" coherente con el tipo de operación.
  urlOperacion(r) {
    if (r.tipo_op === 'C')  return `/alquileres/contenedores/${r.id}`
    if (r.tipo_op === 'MA') return `/alquileres/maquinaria/${r.id}`
    return `/ventas/${r.id}`
  },
}

module.exports = RemitosModel
