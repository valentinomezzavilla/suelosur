'use strict'
const AlquileresMaquinariaModel = require('../models/alquileres_maquinaria.model')
const MaquinariaModel           = require('../models/maquinaria.model')
const TransaccionesModel        = require('../models/transacciones.model')
const ClientesModel             = require('../models/clientes.model')
const ConfigMaquinariaModel     = require('../models/config_maquinaria.model')
const OperacionesModel          = require('../models/operaciones.model')

const AlquileresMaquinariaController = {

  async index(req, res) {
    try {
      const grupos = await AlquileresMaquinariaModel.listarPorEstado()
      res.render('pages/alquileres/maquinaria_index', { titulo: 'Alquileres — Maquinaria', grupos })
    } catch (err) {
      console.error(err)
      req.flash('error', 'Error al cargar los alquileres de maquinaria.')
      res.redirect('/maquinaria')
    }
  },

  async nuevo(req, res) {
    try {
      const disponibles  = await MaquinariaModel.disponibles()
      const choferes     = await MaquinariaModel.choferes()
      const configDefaults = await ConfigMaquinariaModel.obtenerDefaults()
      res.render('pages/alquileres/maquinaria_nuevo', {
        titulo: 'Nuevo Alquiler de Maquinaria',
        disponibles, choferes, configDefaults,
        scripts: ['/js/buscarCliente.js', '/js/formValidation.js', '/js/alquilerMaquinariaService.js'],
      })
    } catch (err) {
      console.error(err)
      req.flash('error', 'Error al cargar el formulario.')
      res.redirect('/alquileres/maquinaria')
    }
  },

  async crear(req, res) {
    try {
      const { clienteId, calle, numero, zona_entrega, plazo_alquiler, modo_precio, precio_por_hora, horas_pactadas, precio_total, id_maquinaria, id_chofer, metodoPago, observaciones } = req.body
      const clienteIdClean = (clienteId && clienteId.trim()) || null
      if (!clienteIdClean) {
        req.flash('error', 'Seleccioná un cliente.')
        return res.redirect('/alquileres/maquinaria/nuevo')
      }

      const domicilio_entrega = `${calle || ''} ${numero || ''}`.trim()
      const { nro_op } = await AlquileresMaquinariaModel.crear({
        id_cliente: clienteIdClean, id_administrativo: req.session.user.id,
        domicilio_entrega, domicilio_calle: calle, domicilio_numero: numero,
        zona_entrega, plazo_alquiler,
        precio_por_hora, horas_pactadas, precio_total,
        id_maquinaria: id_maquinaria || null,
        id_chofer: id_chofer || null,
        metodo_pago: metodoPago,
        observaciones,
      })
      req.flash('success', `Alquiler maquinaria OP-${String(nro_op).padStart(4,'0')} creado.`)
      res.redirect('/alquileres/maquinaria')
    } catch (err) {
      console.error(err)
      req.flash('error', 'Error al crear el alquiler.')
      res.redirect('/alquileres/maquinaria/nuevo')
    }
  },

  async detalle(req, res) {
    try {
      const alquiler    = await AlquileresMaquinariaModel.obtener(req.params.id)
      if (!alquiler) { req.flash('error', 'Alquiler no encontrado.'); return res.redirect('/alquileres/maquinaria') }
      const disponibles = await MaquinariaModel.disponibles()
      const recursos = await OperacionesModel.obtenerRecursos(alquiler.id)
      const choferesDisp = await OperacionesModel.choferesDisponibles()
      if (recursos?.id_chofer && !choferesDisp.some(c => c.id === recursos.id_chofer)) {
        const extra = await OperacionesModel.obtenerChofer(recursos.id_chofer)
        if (extra) choferesDisp.push(extra)
      }
      const solapamiento = req.session.solapamiento?.opId === String(alquiler.id) ? req.session.solapamiento : null
      if (solapamiento) delete req.session.solapamiento
      res.render('pages/alquileres/maquinaria_detalle', {
        titulo: `Alquiler Maq. OP-${String(alquiler.nro_op).padStart(4,'0')}`,
        alquiler, disponibles, recursos, choferesDisp, solapamiento,
        camionesDisp: await OperacionesModel.camionesDisponibles('maquinas'),
        recursosEditable: alquiler.estado !== 'anulado',
      })
    } catch (err) {
      console.error(err)
      req.flash('error', 'Error al cargar.')
      res.redirect('/alquileres/maquinaria')
    }
  },

  async editar(req, res) {
    try {
      const alquiler = await AlquileresMaquinariaModel.obtener(req.params.id)
      if (!alquiler) { req.flash('error', 'Alquiler no encontrado.'); return res.redirect('/alquileres/maquinaria') }
      if (alquiler.estado === 'anulado') { req.flash('error', 'No se puede editar un alquiler anulado.'); return res.redirect(`/alquileres/maquinaria/${alquiler.id}`) }
      res.render('pages/alquileres/maquinaria_editar', { titulo: `Editar Maq. OP-${String(alquiler.nro_op).padStart(4,'0')}`, alquiler })
    } catch (err) {
      console.error(err); req.flash('error', 'Error al cargar el alquiler.'); res.redirect('/alquileres/maquinaria')
    }
  },

  async actualizar(req, res) {
    try {
      await AlquileresMaquinariaModel.actualizar(req.params.id, req.body)
      req.flash('success', 'Alquiler actualizado.')
      res.redirect(`/alquileres/maquinaria/${req.params.id}`)
    } catch (err) {
      console.error(err); req.flash('error', err.message || 'Error al actualizar.'); res.redirect(`/alquileres/maquinaria/${req.params.id}/editar`)
    }
  },

  async asignarMaquinaria(req, res) {
    try {
      const { id_maquinaria } = req.body
      if (!id_maquinaria) { req.flash('error', 'Seleccioná una máquina.'); return res.redirect(`/alquileres/maquinaria/${req.params.id}`) }
      await AlquileresMaquinariaModel.asignarMaquinaria(req.params.id, id_maquinaria)
      req.flash('success', 'Maquinaria asignada.')
    } catch (err) {
      console.error(err); req.flash('error', 'Error al asignar.')
    }
    res.redirect(`/alquileres/maquinaria/${req.params.id}`)
  },

  async despachar(req, res) {
    try {
      await AlquileresMaquinariaModel.despachar(req.params.id)
      req.flash('success', 'Maquinaria despachada.')
    } catch (err) {
      console.error(err); req.flash('error', err.message || 'Error.')
    }
    res.redirect(`/alquileres/maquinaria/${req.params.id}`)
  },

  async entregar(req, res) {
    try {
      const alquiler = await AlquileresMaquinariaModel.obtener(req.params.id)
      await AlquileresMaquinariaModel.entregar(req.params.id)
      if (alquiler) {
        await TransaccionesModel.crear({
          tipo: 'Maquinaria',
          id_op_encabezado: alquiler.id,
          nro_remito: alquiler.nro_remito,
          cliente_id: alquiler.id_cliente,
          cliente: alquiler.cliente_nombre,
          monto: alquiler.detalle?.precio_total || 0,
          descripcion: `Alquiler ${alquiler.detalle?.maquinaria_nombre || 'maquinaria'} — ${alquiler.detalle?.domicilio_entrega || ''}`,
          metodo_pago: alquiler.metodo_pago || 'efectivo',
        })
        if (alquiler.metodo_pago === 'cuenta_corriente' && alquiler.id_cliente) {
          await ClientesModel.agregarMovimiento(alquiler.id_cliente, {
            tipo: 'deuda',
            descripcion: `Alquiler ${alquiler.detalle?.maquinaria_nombre || 'maquinaria'}`,
            monto: -(alquiler.detalle?.precio_total || 0),
          })
        }
      }
      req.flash('success', 'Inicio de trabajo confirmado.')
    } catch (err) {
      console.error(err); req.flash('error', err.message || 'Error.')
    }
    res.redirect(`/alquileres/maquinaria/${req.params.id}`)
  },

  async retirar(req, res) {
    try {
      await AlquileresMaquinariaModel.registrarRetiro(req.params.id)
      req.flash('success', 'Trabajo finalizado — pendiente retiro.')
    } catch (err) {
      console.error(err); req.flash('error', err.message || 'Error.')
    }
    res.redirect(`/alquileres/maquinaria/${req.params.id}`)
  },

  async devolverAPlanta(req, res) {
    try {
      await AlquileresMaquinariaModel.devolverAPlanta(req.params.id)
      req.flash('success', 'Maquinaria devuelta a planta.')
    } catch (err) {
      console.error(err); req.flash('error', err.message || 'Error.')
    }
    res.redirect(`/alquileres/maquinaria/${req.params.id}`)
  },

  async anular(req, res) {
    try {
      await AlquileresMaquinariaModel.anular(req.params.id)
      req.flash('success', 'Alquiler anulado.')
    } catch (err) {
      console.error(err); req.flash('error', 'Error al anular.')
    }
    res.redirect('/alquileres/maquinaria')
  },
}

module.exports = AlquileresMaquinariaController
