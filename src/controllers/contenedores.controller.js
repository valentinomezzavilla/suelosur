'use strict'
const ContenedoresModel = require('../models/contenedores.model')
const AlquileresModel   = require('../models/alquileres.model')
const paginar           = require('../utils/paginar')

const ContenedoresController = {

  async index(req, res) {
    try {
      await AlquileresModel.autoVencerAlquileres().catch(e => console.error('autoVencer:', e.message))
      const { estado_paso, estado_general, q, registro, page } = req.query
      const todos   = await ContenedoresModel.listar({ estado_paso, estado_general, q, registro })
      const resumen = await ContenedoresModel.resumenPorEstado()
      // Las tarjetas de resumen siguen contando el total, no solo la página actual.
      const { items: contenedores, total, page: pag, limit, totalPaginas } = paginar(todos, page, 15)
      res.render('pages/contenedores/index', {
        titulo: 'Contenedores', contenedores, resumen,
        total, page: pag, limit, totalPaginas, filtros: req.query,
      })
    } catch (err) {
      console.error(err)
      req.flash('error', 'Error al cargar los contenedores.')
      res.redirect('back')
    }
  },

  async nuevo(req, res) {
    const proximoNumero = await ContenedoresModel.proximoNumero()
    res.render('pages/contenedores/form', { titulo: 'Nuevo Contenedor', contenedor: null, proximoNumero })
  },

  async crear(req, res) {
    try {
      // El número es autoincrementable: lo asigna el modelo, no el usuario.
      const { numero } = await ContenedoresModel.crear({
        estado_general: req.body.estado_general,
        fecha_ultima_pintada: req.body.fecha_ultima_pintada,
        observaciones: req.body.observaciones,
      })
      req.flash('success', `Contenedor N° ${numero} creado.`)
      res.redirect('/contenedores')
    } catch (err) {
      console.error(err)
      req.flash('error', 'Error al crear el contenedor.')
      res.redirect('/contenedores/nuevo')
    }
  },

  async editar(req, res) {
    try {
      const contenedor = await ContenedoresModel.obtener(req.params.id)
      if (!contenedor) { req.flash('error', 'No encontrado.'); return res.redirect('/contenedores') }
      res.render('pages/contenedores/form', { titulo: 'Editar Contenedor', contenedor })
    } catch (err) {
      console.error(err); req.flash('error', 'Error.'); res.redirect('/contenedores')
    }
  },

  async actualizar(req, res) {
    try {
      // El número de contenedor no se modifica (es autoincrementable e inmutable).
      await ContenedoresModel.actualizar(req.params.id, { estado_general: req.body.estado_general, fecha_ultima_pintada: req.body.fecha_ultima_pintada, observaciones: req.body.observaciones })
      req.flash('success', 'Contenedor actualizado.')
      res.redirect('/contenedores')
    } catch (err) {
      console.error(err); req.flash('error', 'Error.'); res.redirect('/contenedores')
    }
  },

  async toggleActivo(req, res) {
    try {
      await ContenedoresModel.toggleActivo(req.params.id)
      req.flash('success', 'Estado actualizado.')
    } catch (err) {
      console.error(err); req.flash('error', 'Error.')
    }
    res.redirect('/contenedores')
  },

  async detalle(req, res) {
    try {
      await AlquileresModel.autoVencerAlquileres().catch(e => console.error('autoVencer:', e.message))
      const contenedor = await ContenedoresModel.obtener(req.params.id)
      if (!contenedor) { req.flash('error', 'No encontrado.'); return res.redirect('/contenedores') }
      const choferes = await ContenedoresModel.choferes()
      const camiones = await ContenedoresModel.camiones()
      res.render('pages/contenedores/detalle', { titulo: `Contenedor N° ${contenedor.numero_contenedor}`, contenedor, choferes, camiones })
    } catch (err) {
      console.error(err); req.flash('error', 'Error.'); res.redirect('/contenedores')
    }
  },

  async registrarMovimiento(req, res) {
    try {
      const { estado_paso, id_chofer, id_camion, observaciones, fecha_movimiento } = req.body
      if (!estado_paso) { req.flash('error', 'Indicá el nuevo estado.'); return res.redirect(`/contenedores/${req.params.id}`) }
      await ContenedoresModel.registrarMovimiento({ id_contenedor: req.params.id, estado_paso, id_chofer: id_chofer || null, id_camion: id_camion || null, observaciones, fecha_movimiento: fecha_movimiento || null })
      req.flash('success', `Movimiento registrado: ${estado_paso.replace('_',' ')}.`)
      res.redirect(`/contenedores/${req.params.id}`)
    } catch (err) {
      console.error(err); req.flash('error', 'Error.'); res.redirect(`/contenedores/${req.params.id}`)
    }
  },

  async circuito(req, res) {
    try {
      const items = await ContenedoresModel.circuitoDiario()
      const porZona = items.reduce((acc, it) => {
        const z = it.zona_entrega || 'Sin zona'
        ;(acc[z] = acc[z] || []).push(it)
        return acc
      }, {})
      res.render('pages/contenedores/circuito', { titulo: 'Circuito del Día', porZona, total: items.length })
    } catch (err) {
      console.error(err); req.flash('error', 'Error.'); res.redirect('/contenedores')
    }
  },

  // ── Cobranzas: alquileres "a convenir" ya retirados y sin cobrar ──────────────
  async cobranzas(req, res) {
    try {
      const pendientes = await AlquileresModel.pendientesDeCobro()
      // Monto estimado con la tarifa vigente (misma cuenta que se usaría al cerrar el
      // cobro), para que se vea de un vistazo cuánto habría que cobrar en cada caso.
      for (const p of pendientes) {
        const cierre = await AlquileresModel.datosCierre(p.id)
        p.montoEstimado = cierre ? cierre.precioActual : (p.precio_alquiler || 0)
      }
      res.render('pages/contenedores/cobranzas', { titulo: 'Cobranzas de Contenedores', pendientes })
    } catch (err) {
      console.error(err); req.flash('error', 'Error al cargar las cobranzas.'); res.redirect('/contenedores')
    }
  },

  // Resuelve un "a convenir" pendiente: cobra con el método elegido ahora.
  async resolverCobranza(req, res) {
    const back = '/contenedores/cobranzas'
    try {
      const { metodo_pago_final, precio_final } = req.body
      if (!metodo_pago_final) {
        req.flash('error', 'Elegí un método de pago para cerrar el cobro.')
        return res.redirect(back)
      }
      const monto = await AlquileresModel.cobrarAlCerrar(req.params.id, precio_final, metodo_pago_final)
      if (monto == null) {
        req.flash('error', 'No se pudo cerrar el cobro (puede que ya estuviera registrado).')
      } else {
        req.flash('success', `Cobro registrado por $${Math.round(monto).toLocaleString('es-AR')}.`)
      }
    } catch (err) {
      console.error(err)
      req.flash('error', err.message || 'Error al registrar el cobro.')
    }
    res.redirect(back)
  },
}

module.exports = ContenedoresController
