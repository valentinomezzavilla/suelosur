'use strict'
const AlquileresModel        = require('../models/alquileres.model')
const TransaccionesModel     = require('../models/transacciones.model')
const ClientesModel          = require('../models/clientes.model')
const ConfigContenedoresModel = require('../models/config_contenedores.model')
const OperacionesModel        = require('../models/operaciones.model')

const AlquileresController = {

  async index(req, res) {
    try {
      await AlquileresModel.autoVencerAlquileres().catch(e => console.error('autoVencer:', e.message))
      const grupos = await AlquileresModel.listarPorEstado()
      res.render('pages/alquileres/index', { titulo: 'Alquileres — Contenedores', grupos })
    } catch (err) {
      console.error(err)
      req.flash('error', 'Error al cargar los alquileres.')
      res.redirect('/contenedores')
    }
  },

  async nuevo(req, res) {
    try {
      const [{ disponibles, porLiberar }, configPrecios, choferesDisp, camionesDisp, zonas] = await Promise.all([
        AlquileresModel.contenedoresDisponibles(),
        ConfigContenedoresModel.obtenerPrecios(),
        OperacionesModel.choferesDisponibles(),
        OperacionesModel.camionesDisponibles('contenedores'),
        require('../models/zonas.model').listarActivas(),
      ])
      res.render('pages/alquileres/nuevo', {
        titulo: 'Nuevo Alquiler de Contenedor',
        disponibles, porLiberar, configPrecios, choferesDisp, camionesDisp, zonas,
        scripts: ['/js/buscarCliente.js', '/js/formValidation.js', '/js/alquilerService.js'],
      })
    } catch (err) {
      console.error(err)
      req.flash('error', 'Error al cargar el formulario.')
      res.redirect('/alquileres/contenedores')
    }
  },

  async crear(req, res) {
    try {
      const { clienteId, calle, numero, zona_entrega, fechaInicio, fechaFin, horaEntrega, precio_alquiler, id_contenedor, metodoPago, observaciones, alquiler_actual_id, id_chofer, id_camion, obra } = req.body
      const clienteIdClean = (clienteId && clienteId.trim()) || null
      if (!clienteIdClean) {
        req.flash('error', 'Seleccioná un cliente.')
        return res.redirect('/alquileres/contenedores/nuevo')
      }

      // Destino: se exige dirección (calle) u obra, al menos uno.
      if (!(calle || '').trim() && !(obra || '').trim()) {
        req.flash('error', 'Cargá la dirección (calle) o la obra. Al menos uno es obligatorio.')
        return res.redirect('/alquileres/contenedores/nuevo')
      }

      const domicilio_entrega = `${calle || ''} ${numero || ''}`.trim()
      let plazo_alquiler = 5
      if (fechaInicio && fechaFin) {
        plazo_alquiler = Math.round((new Date(fechaFin) - new Date(fechaInicio)) / 86400000)
      }

      // ── Carga histórica: alquiler ya finalizado (ingreso + historial, sin contenedor) ──
      if (req.body.finalizado === '1' || req.body.finalizado === 'on') {
        const result = await AlquileresModel.crearFinalizado({
          id_cliente: clienteIdClean, id_administrativo: req.session.user.id,
          domicilio_entrega, domicilio_calle: calle, domicilio_numero: numero,
          zona_entrega, plazo_alquiler, precio_alquiler,
          metodo_pago: metodoPago, observaciones, obra,
          fecha_inicio: fechaInicio || null, fecha_fin: fechaFin || null,
        })
        const monto = parseFloat(precio_alquiler) || 0
        await TransaccionesModel.crear({
          tipo: 'Alquiler', id_op_encabezado: result.id, nro_remito: result.nro_remito,
          cliente_id: clienteIdClean, cliente: result.cliente_nombre, monto,
          descripcion: `Alquiler contenedor (histórico)${domicilio_entrega ? ' — ' + domicilio_entrega : ''}`,
          metodo_pago: metodoPago || 'efectivo',
          fecha: fechaFin || fechaInicio || null,
        })
        if (metodoPago === 'cuenta_corriente' && clienteIdClean) {
          await ClientesModel.agregarMovimiento(clienteIdClean, {
            tipo: 'deuda',
            descripcion: `Alquiler contenedor (histórico) OP-${String(result.nro_op).padStart(4, '0')}`,
            monto: -monto,
          })
        }
        req.flash('success', `Alquiler finalizado OP-${String(result.nro_op).padStart(4, '0')} cargado (histórico).`)
        return res.redirect('/alquileres/contenedores')
      }

      const esProgramado = !!alquiler_actual_id

      let result
      if (esProgramado) {
        result = await AlquileresModel.crearProgramado({
          id_cliente: clienteIdClean, id_administrativo: req.session.user.id,
          domicilio_entrega, domicilio_calle: calle, domicilio_numero: numero,
          zona_entrega, plazo_alquiler, precio_alquiler,
          id_contenedor: id_contenedor || null, metodo_pago: metodoPago,
          observaciones, obra, alquiler_actual_id,
          fecha_entrega_planificada: fechaInicio || null, hora_planificada: horaEntrega || null,
        })
      } else {
        result = await AlquileresModel.crear({
          id_cliente: clienteIdClean, id_administrativo: req.session.user.id,
          domicilio_entrega, zona_entrega, plazo_alquiler, precio_alquiler,
          id_contenedor: id_contenedor || null, observaciones, obra,
          fecha_entrega_planificada: fechaInicio || null, hora_planificada: horaEntrega || null,
          id_chofer: id_chofer || null, id_camion: id_camion || null,
        })
      }

      req.flash('success', `Alquiler OP-${String(result.nro_op).padStart(4,'0')} ${esProgramado ? 'programado' : 'creado'}.`)
      res.redirect('/alquileres/contenedores')
    } catch (err) {
      console.error(err)
      req.flash('error', err.message || 'Error al crear el alquiler.')
      res.redirect('/alquileres/contenedores/nuevo')
    }
  },

  async detalle(req, res) {
    try {
      await AlquileresModel.autoVencerAlquileres().catch(e => console.error('autoVencer:', e.message))
      const alquiler = await AlquileresModel.obtener(req.params.id)
      if (!alquiler) { req.flash('error', 'Alquiler no encontrado.'); return res.redirect('/alquileres/contenedores') }
      const { disponibles } = await AlquileresModel.contenedoresDisponibles()
      const recursos = await OperacionesModel.obtenerRecursos(alquiler.id)
      const choferesDisp = await OperacionesModel.choferesDisponibles()
      if (recursos?.id_chofer && !choferesDisp.some(c => c.id === recursos.id_chofer)) {
        const extra = await OperacionesModel.obtenerChofer(recursos.id_chofer)
        if (extra) choferesDisp.push(extra)
      }
      const solapamiento = req.session.solapamiento?.opId === String(alquiler.id) ? req.session.solapamiento : null
      if (solapamiento) delete req.session.solapamiento
      res.render('pages/alquileres/detalle', {
        titulo: `Alquiler OP-${String(alquiler.nro_op).padStart(4,'0')}`,
        alquiler, disponibles, recursos, choferesDisp, solapamiento,
        camionesDisp: await OperacionesModel.camionesDisponibles('contenedores'),
        recursosEditable: alquiler.estado !== 'anulado',
      })
    } catch (err) {
      console.error(err)
      req.flash('error', 'Error al cargar el alquiler.')
      res.redirect('/alquileres/contenedores')
    }
  },

  async editar(req, res) {
    try {
      const alquiler = await AlquileresModel.obtener(req.params.id)
      if (!alquiler) { req.flash('error', 'Alquiler no encontrado.'); return res.redirect('/alquileres/contenedores') }
      if (alquiler.estado === 'anulado') { req.flash('error', 'No se puede editar un alquiler anulado.'); return res.redirect(`/alquileres/contenedores/${alquiler.id}`) }
      res.render('pages/alquileres/editar', {
        titulo: `Editar OP-${String(alquiler.nro_op).padStart(4,'0')}`, alquiler,
        zonas: await require('../models/zonas.model').listarActivas(),
      })
    } catch (err) {
      console.error(err); req.flash('error', 'Error al cargar el alquiler.'); res.redirect('/alquileres/contenedores')
    }
  },

  async actualizar(req, res) {
    try {
      const { fechaInicio, fechaFin } = req.body
      let plazo_alquiler = req.body.plazo_alquiler
      if (fechaInicio && fechaFin) {
        plazo_alquiler = Math.max(1, Math.round((new Date(fechaFin) - new Date(fechaInicio)) / 86400000))
      }
      await AlquileresModel.actualizar(req.params.id, {
        ...req.body,
        plazo_alquiler,
        fecha_entrega_planificada: fechaInicio || req.body.fecha_entrega_planificada || null,
      })
      req.flash('success', 'Alquiler actualizado.')
      res.redirect(`/alquileres/contenedores/${req.params.id}`)
    } catch (err) {
      console.error(err); req.flash('error', err.message || 'Error al actualizar.'); res.redirect(`/alquileres/contenedores/${req.params.id}/editar`)
    }
  },

  async asignarContenedor(req, res) {
    try {
      const { id_contenedor } = req.body
      if (!id_contenedor) { req.flash('error', 'Seleccioná un contenedor.'); return res.redirect(`/alquileres/contenedores/${req.params.id}`) }
      await AlquileresModel.asignarContenedor(req.params.id, id_contenedor)
      req.flash('success', 'Contenedor asignado.')
    } catch (err) {
      console.error(err)
      req.flash('error', 'Error al asignar el contenedor.')
    }
    res.redirect(`/alquileres/contenedores/${req.params.id}`)
  },

  async despachar(req, res) {
    try {
      await AlquileresModel.despachar(req.params.id)
      req.flash('success', 'Contenedor despachado.')
    } catch (err) {
      console.error(err)
      req.flash('error', err.message || 'Error al despachar.')
    }
    res.redirect(`/alquileres/contenedores/${req.params.id}`)
  },

  async entregar(req, res) {
    try {
      const alquiler = await AlquileresModel.obtener(req.params.id)
      await AlquileresModel.entregar(req.params.id)
      if (alquiler) {
        await TransaccionesModel.crear({
          tipo: 'Alquiler',
          id_op_encabezado: alquiler.id,
          nro_remito: alquiler.nro_remito,
          cliente_id: alquiler.id_cliente,
          cliente: alquiler.cliente_nombre,
          monto: alquiler.detalle?.precio_alquiler || 0,
          descripcion: `Alquiler contenedor #${alquiler.detalle?.numero_contenedor || '?'} — ${alquiler.detalle?.domicilio_entrega || ''}`,
          metodo_pago: alquiler.metodo_pago || 'efectivo',
        })
        if (alquiler.metodo_pago === 'cuenta_corriente' && alquiler.id_cliente) {
          await ClientesModel.agregarMovimiento(alquiler.id_cliente, {
            tipo: 'deuda',
            descripcion: `Alquiler contenedor #${alquiler.detalle?.numero_contenedor || '?'}`,
            monto: -(alquiler.detalle?.precio_alquiler || 0),
          })
        }
      }
      req.flash('success', 'Entrega confirmada.')
    } catch (err) {
      console.error(err)
      req.flash('error', err.message || 'Error al confirmar entrega.')
    }
    res.redirect(`/alquileres/contenedores/${req.params.id}`)
  },

  async retirar(req, res) {
    try {
      await AlquileresModel.registrarRetiro(req.params.id)
      req.flash('success', 'Retiro registrado.')
    } catch (err) {
      console.error(err)
      req.flash('error', err.message || 'Error al registrar retiro.')
    }
    res.redirect(`/alquileres/contenedores/${req.params.id}`)
  },

  async devolverAPlanta(req, res) {
    try {
      const alquiler = await AlquileresModel.obtener(req.params.id)
      await AlquileresModel.devolverAPlanta(req.params.id)
      if (alquiler?.detalle?.alquiler_siguiente_id) {
        await AlquileresModel.activarProgramado(alquiler.detalle.alquiler_siguiente_id)
      }
      req.flash('success', 'Contenedor devuelto a planta — ciclo completado.')
    } catch (err) {
      console.error(err)
      req.flash('error', err.message || 'Error al registrar devolución.')
    }
    res.redirect(`/alquileres/contenedores/${req.params.id}`)
  },

  async anular(req, res) {
    try {
      await AlquileresModel.anular(req.params.id)
      req.flash('success', 'Alquiler anulado.')
    } catch (err) {
      console.error(err)
      req.flash('error', 'Error al anular.')
    }
    res.redirect('/alquileres/contenedores')
  },
}

module.exports = AlquileresController
