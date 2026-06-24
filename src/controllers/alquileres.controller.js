'use strict'
const AlquileresModel        = require('../models/alquileres.model')
const TransaccionesModel     = require('../models/transacciones.model')
const ClientesModel          = require('../models/clientes.model')
const ConfigContenedoresModel = require('../models/config_contenedores.model')
const OperacionesModel        = require('../models/operaciones.model')

const AlquileresController = {

  async index(req, res) {
    try {
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
      const { disponibles, porLiberar } = await AlquileresModel.contenedoresDisponibles()
      const configPrecios = await ConfigContenedoresModel.obtenerPrecios()
      res.render('pages/alquileres/nuevo', {
        titulo: 'Nuevo Alquiler de Contenedor',
        disponibles, porLiberar, configPrecios,
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
      const { clienteId, calle, numero, zona_entrega, fechaInicio, fechaFin, precio_alquiler, id_contenedor, metodoPago, observaciones, alquiler_actual_id } = req.body
      const clienteIdClean = (clienteId && clienteId.trim()) || null
      if (!clienteIdClean) {
        req.flash('error', 'Seleccioná un cliente.')
        return res.redirect('/alquileres/contenedores/nuevo')
      }

      const domicilio_entrega = `${calle || ''} ${numero || ''}`.trim()
      let plazo_alquiler = 5
      if (fechaInicio && fechaFin) {
        plazo_alquiler = Math.round((new Date(fechaFin) - new Date(fechaInicio)) / 86400000)
      }

      const esProgramado = !!alquiler_actual_id

      let result
      if (esProgramado) {
        result = await AlquileresModel.crearProgramado({
          id_cliente: clienteIdClean, id_administrativo: req.session.user.id,
          domicilio_entrega, domicilio_calle: calle, domicilio_numero: numero,
          zona_entrega, plazo_alquiler, precio_alquiler,
          id_contenedor: id_contenedor || null, metodo_pago: metodoPago,
          observaciones, alquiler_actual_id,
        })
      } else {
        result = await AlquileresModel.crear({
          id_cliente: clienteIdClean, id_administrativo: req.session.user.id,
          domicilio_entrega, zona_entrega, plazo_alquiler, precio_alquiler,
          id_contenedor: id_contenedor || null, observaciones,
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
      const alquiler = await AlquileresModel.obtener(req.params.id)
      if (!alquiler) { req.flash('error', 'Alquiler no encontrado.'); return res.redirect('/alquileres/contenedores') }
      const { disponibles } = await AlquileresModel.contenedoresDisponibles()
      res.render('pages/alquileres/detalle', {
        titulo: `Alquiler OP-${String(alquiler.nro_op).padStart(4,'0')}`,
        alquiler, disponibles,
        recursos: await OperacionesModel.obtenerRecursos(alquiler.id),
        choferesDisp: await OperacionesModel.choferesDisponibles(),
        camionesDisp: await OperacionesModel.camionesDisponibles(),
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
      res.render('pages/alquileres/editar', { titulo: `Editar OP-${String(alquiler.nro_op).padStart(4,'0')}`, alquiler })
    } catch (err) {
      console.error(err); req.flash('error', 'Error al cargar el alquiler.'); res.redirect('/alquileres/contenedores')
    }
  },

  async actualizar(req, res) {
    try {
      await AlquileresModel.actualizar(req.params.id, req.body)
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
      req.flash('success', 'Contenedor despachado — movimiento "en tránsito" registrado.')
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
