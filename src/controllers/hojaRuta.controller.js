'use strict'
const db = require('../config/db')

const TIPO_LBL = { M: 'Material', C: 'Contenedor', MA: 'Maquinaria' }

const HojaRutaController = {
  index(req, res) {
    try {
      const userId = req.session.user.id
      // Empleado vinculado al usuario logueado
      const empleado = db.prepare(`SELECT id, nombre, apellido FROM empleados WHERE id_usuario = ?`).get(userId)

      let paradas = []
      if (empleado) {
        paradas = db.prepare(`
          SELECT op.id, op.nro_op, op.tipo_op, op.estado, op.fecha_emision, op.fecha_entrega_planificada,
                 op.domicilio_calle, op.domicilio_altura, op.observaciones,
                 COALESCE(c.nombre, 'Particular') AS cliente_nombre, c.tel_whatsapp,
                 v.patente AS camion_patente, v.nombre AS camion_nombre
          FROM op_encabezado op
          LEFT JOIN clientes c ON c.id = op.id_cliente
          LEFT JOIN flota_vehiculos v ON v.id = op.id_camion
          WHERE op.id_chofer = ? AND op.estado IN ('pendiente','despachado')
          ORDER BY (op.fecha_entrega_planificada IS NULL), op.fecha_entrega_planificada, op.created_at
        `).all(empleado.id).map(p => {
          // Domicilio del material flete o del contenedor/máquina
          let domicilio = [p.domicilio_calle, p.domicilio_altura].filter(Boolean).join(' ').trim()
          if (!domicilio) {
            if (p.tipo_op === 'C') {
              const d = db.prepare(`SELECT domicilio_entrega FROM op_detalle_contenedor WHERE id_orden_pedido = ? LIMIT 1`).get(p.id)
              domicilio = d ? d.domicilio_entrega : ''
            } else if (p.tipo_op === 'MA') {
              const d = db.prepare(`SELECT domicilio_entrega FROM op_detalle_maquinaria WHERE id_orden_pedido = ? LIMIT 1`).get(p.id)
              domicilio = d ? d.domicilio_entrega : ''
            }
          }
          return { ...p, domicilio, tipoLabel: TIPO_LBL[p.tipo_op] || p.tipo_op }
        })
      }

      res.render('pages/hoja_ruta', { titulo: 'Hoja de Ruta', empleado, paradas })
    } catch (err) {
      console.error(err); req.flash('error', 'Error al cargar la hoja de ruta.'); res.redirect('/')
    }
  },
}

module.exports = HojaRutaController
