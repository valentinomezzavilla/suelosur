'use strict'
const AlquileresMaquinariaModel = require('../models/alquileres_maquinaria.model')
const MaquinariaModel           = require('../models/maquinaria.model')
const TransaccionesModel        = require('../models/transacciones.model')
const ClientesModel             = require('../models/clientes.model')
const ConfigMaquinariaModel     = require('../models/config_maquinaria.model')

const AlquileresMaquinariaController = {

  index(req, res) {
    try {
      const grupos = AlquileresMaquinariaModel.listarPorEstado()
      res.render('pages/alquileres/maquinaria_index', { titulo: 'Alquileres — Maquinaria', grupos })
    } catch (err) {
      console.error(err)
      req.flash('error', 'Error al cargar los alquileres de maquinaria.')
      res.redirect('/maquinaria')
    }
  },

  nuevo(req, res) {
    try {
      const disponibles  = MaquinariaModel.disponibles()
      const choferes     = MaquinariaModel.choferes()
      const configDefaults = ConfigMaquinariaModel.obtenerDefaults()
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

  crear(req, res) {
    try {
      const { clienteId, calle, numero, zona_entrega, plazo_alquiler, modo_precio, precio_por_hora, horas_pactadas, precio_total, id_maquinaria, id_chofer, metodoPago, observaciones } = req.body
      const clienteIdClean = (clienteId && clienteId.trim()) || null
      if (!clienteIdClean) {
        req.flash('error', 'Seleccioná un cliente.')
        return res.redirect('/alquileres/maquinaria/nuevo')
      }

      const domicilio_entrega = `${calle || ''} ${numero || ''}`.trim()
      const { nro_op } = AlquileresMaquinariaModel.crear({
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

  detalle(req, res) {
    try {
      const alquiler    = AlquileresMaquinariaModel.obtener(req.params.id)
      if (!alquiler) { req.flash('error', 'Alquiler no encontrado.'); return res.redirect('/alquileres/maquinaria') }
      const disponibles = MaquinariaModel.disponibles()
      res.render('pages/alquileres/maquinaria_detalle', {
        titulo: `Alquiler Maq. OP-${String(alquiler.nro_op).padStart(4,'0')}`,
        alquiler, disponibles,
      })
    } catch (err) {
      console.error(err)
      req.flash('error', 'Error al cargar.')
      res.redirect('/alquileres/maquinaria')
    }
  },

  asignarMaquinaria(req, res) {
    try {
      const { id_maquinaria } = req.body
      if (!id_maquinaria) { req.flash('error', 'Seleccioná una máquina.'); return res.redirect(`/alquileres/maquinaria/${req.params.id}`) }
      AlquileresMaquinariaModel.asignarMaquinaria(req.params.id, id_maquinaria)
      req.flash('success', 'Maquinaria asignada.')
    } catch (err) {
      console.error(err); req.flash('error', 'Error al asignar.')
    }
    res.redirect(`/alquileres/maquinaria/${req.params.id}`)
  },

  despachar(req, res) {
    try {
      AlquileresMaquinariaModel.despachar(req.params.id)
      req.flash('success', 'Maquinaria despachada.')
    } catch (err) {
      console.error(err); req.flash('error', err.message || 'Error.')
    }
    res.redirect(`/alquileres/maquinaria/${req.params.id}`)
  },

  entregar(req, res) {
    try {
      const alquiler = AlquileresMaquinariaModel.obtener(req.params.id)
      AlquileresMaquinariaModel.entregar(req.params.id)
      if (alquiler) {
        TransaccionesModel.crear({
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
          ClientesModel.agregarMovimiento(alquiler.id_cliente, {
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

  retirar(req, res) {
    try {
      AlquileresMaquinariaModel.registrarRetiro(req.params.id)
      req.flash('success', 'Trabajo finalizado — pendiente retiro.')
    } catch (err) {
      console.error(err); req.flash('error', err.message || 'Error.')
    }
    res.redirect(`/alquileres/maquinaria/${req.params.id}`)
  },

  devolverAPlanta(req, res) {
    try {
      AlquileresMaquinariaModel.devolverAPlanta(req.params.id)
      req.flash('success', 'Maquinaria devuelta a planta.')
    } catch (err) {
      console.error(err); req.flash('error', err.message || 'Error.')
    }
    res.redirect(`/alquileres/maquinaria/${req.params.id}`)
  },

  anular(req, res) {
    try {
      AlquileresMaquinariaModel.anular(req.params.id)
      req.flash('success', 'Alquiler anulado.')
    } catch (err) {
      console.error(err); req.flash('error', 'Error al anular.')
    }
    res.redirect('/alquileres/maquinaria')
  },
}

module.exports = AlquileresMaquinariaController
