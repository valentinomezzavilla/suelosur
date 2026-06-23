'use strict'
const VentasModel       = require('../models/ventas.model')
const TransaccionesModel = require('../models/transacciones.model')
const ClientesModel     = require('../models/clientes.model')
const OperacionesModel  = require('../models/operaciones.model')
const AsignacionesModel = require('../models/asignaciones.model')
const db                = require('../config/db')
const { resolverPeriodo, etiquetaPeriodo } = require('../utils/periodos')

const VentasController = {

  index(req, res) {
    try {
      const { estado, id_cliente, q, sort, dir, page, preset, fechaDesde, fechaHasta, mes } = req.query
      const periodo = resolverPeriodo({ preset, desde: fechaDesde, hasta: fechaHasta, mes })

      const filtrosBase = { estado, id_cliente, q, fechaDesde: periodo.desde, fechaHasta: periodo.hasta }
      const paginacion = VentasModel.listar({ ...filtrosBase, sort, dir, page: parseInt(page) || 1, limit: 15 })
      const clientes   = VentasModel.listarClientes()
      const resumen    = VentasModel.contarPorEstado()
      const metricas   = VentasModel.resumen(filtrosBase)

      res.render('pages/ventas/index', {
        titulo: 'Ventas',
        ...paginacion,
        clientes,
        resumen,
        metricas,
        periodoLabel: etiquetaPeriodo(periodo),
        filtros: { ...req.query, fechaDesde: periodo.desde || '', fechaHasta: periodo.hasta || '', preset: periodo.preset || '' },
      })
    } catch (err) {
      console.error(err)
      req.flash('error', 'Error al cargar las ventas.')
      res.redirect('back')
    }
  },

  // ── Venta en cantera ─────────────────────────────────────────
  cantera(req, res) {
    try {
      const productos = VentasModel.listarProductos()
      res.render('pages/ventas/cantera', {
        titulo: 'Venta en Cantera',
        productos,
        scripts: ['/js/buscarCliente.js', '/js/formValidation.js', '/js/ventasCantera.js'],
      })
    } catch (err) {
      console.error(err)
      req.flash('error', 'Error al cargar productos.')
      res.redirect('/ventas')
    }
  },

  finalizarCantera(req, res) {
    try {
      const { clienteId, clienteNombre, items, metodoPago, precioTotal } = req.body
      const clienteIdClean = (clienteId && clienteId.trim()) || null
      let carrito = []
      try { carrito = JSON.parse(items || '[]') } catch (_) {}
      if (!carrito.length) { req.flash('error', 'El carrito está vacío.'); return res.redirect('/ventas/cantera') }
      const total  = precioTotal ? Number(precioTotal) : carrito.reduce((a, p) => a + p.precio * p.cantidad, 0)
      const nombre = clienteNombre || 'Particular'
      const desc   = carrito.map(p => `${p.nombre} x${p.cantidad}`).join(', ')

      const detalles = carrito.map(p => ({
        id_producto:     p.id,
        cantidad_pedida: p.cantidad,
        precio_unitario: p.precio,
      }))

      const { id: id_op, nro_op, nro_remito } = VentasModel.crear({
        id_cliente:          clienteIdClean,
        cliente_nombre_libre: !clienteIdClean ? nombre : null,
        id_administrativo:   req.session.user.id,
        tipo_op:             'M',
        modalidad:           'deposito',
        metodo_pago:         metodoPago || 'efectivo',
        observaciones:       desc,
        detalles,
      })

      VentasModel.entregar(id_op)

      TransaccionesModel.crear({
        tipo:            'Venta Cantera',
        id_op_encabezado: id_op,
        nro_remito,
        cliente_id:      clienteIdClean,
        cliente:         nombre,
        monto:           total,
        descripcion:     desc,
        metodo_pago:     metodoPago || 'efectivo',
      })

      if (metodoPago === 'cuenta_corriente' && clienteIdClean) {
        ClientesModel.agregarMovimiento(clienteIdClean, {
          tipo: 'deuda',
          descripcion: `Venta Cantera: ${desc}`,
          monto: -total,
        })
      }

      res.redirect(`/ventas/cantera/confirmacion?tipo=cantera&cliente=${encodeURIComponent(nombre)}&total=${total}&remito=${nro_remito}`)
    } catch (err) {
      console.error(err)
      req.flash('error', 'Error al finalizar la venta.')
      res.redirect('/ventas/cantera')
    }
  },

  confirmacionCantera(req, res) {
    const { tipo, cliente, total, remito } = req.query
    res.render('pages/ventas/confirmacion', {
      titulo: 'Venta confirmada',
      tipo: tipo || 'cantera',
      cliente: cliente || '',
      total: total || 0,
      remito: remito || null,
    })
  },

  // ── Venta con viaje (flete) ───────────────────────────────────
  viaje(req, res) {
    try {
      const productos  = VentasModel.listarProductos()
      const viajesHoy  = VentasModel.listarViajesPendientesHoy()
      const viajesTodos = VentasModel.listarViajesPendientes()
      const choferes = db.prepare(`
        SELECT e.id, e.nombre, e.apellido FROM empleados e
        WHERE e.es_chofer = 1 AND e.activo = 1
        ORDER BY e.apellido, e.nombre
      `).all()
      const camiones = db.prepare(`
        SELECT v.id, v.numero_interno, v.patente, v.nombre, v.marca, v.modelo
        FROM flota_vehiculos v
        WHERE v.activo = 1
          AND COALESCE(v.estado_operativo, 'disponible') NOT IN ('en_mantenimiento','fuera_servicio','inactivo')
          AND COALESCE(v.dedicacion, 'ambos') IN ('ambos','ventas')
        ORDER BY v.numero_interno, v.nombre
      `).all()
      res.render('pages/ventas/viaje', {
        titulo: 'Venta con Viaje',
        productos, viajesHoy, viajesTodos, choferes, camiones,
        scripts: ['/js/buscarCliente.js', '/js/formValidation.js', '/js/ventasViaje.js'],
      })
    } catch (err) {
      console.error(err)
      req.flash('error', 'Error al cargar la página.')
      res.redirect('/ventas')
    }
  },

  // ── API: asignación chofer ↔ camión ────────────────────────────
  // Dado un id de camión, devuelve el chofer que lo tiene asignado (si hay)
  apiChoferDeCamion(req, res) {
    try {
      const chofer = AsignacionesModel.choferDeRecurso('camion', req.params.idCamion)
      if (!chofer) return res.json(null)
      return res.json({
        id: chofer.id_empleado,
        nombre: `${chofer.nombre} ${chofer.apellido || ''}`.trim(),
        legajo: chofer.legajo,
      })
    } catch (err) { console.error(err); res.status(500).json({ error: 'Error' }) }
  },

  // Dado un id de empleado/chofer, devuelve el camión que tiene asignado (si hay)
  apiCamionDeChofer(req, res) {
    try {
      const asig = AsignacionesModel.recursoActivo(req.params.idChofer, 'camion')
      if (!asig) return res.json(null)
      const camion = db.prepare(`SELECT id, numero_interno, patente, nombre, marca, modelo FROM flota_vehiculos WHERE id = ?`).get(asig.recurso_id)
      return res.json(camion || null)
    } catch (err) { console.error(err); res.status(500).json({ error: 'Error' }) }
  },

  crearViaje(req, res) {
    try {
      const {
        clienteId, clienteNombre, telefono, fecha, hora, calle, numero,
        productoId, cantidad, precioProducto, precioFlete, precioTotal,
        metodoPago, descripcion, finalizarAhora,
        idChofer, idCamion,
      } = req.body

      const cantidadNum = Number(cantidad) || 1
      const esFinalizarAhora = finalizarAhora === 'true'
      const direccion = `${calle || ''} ${numero || ''}`.trim()
      const total     = Number(precioTotal) || 0

      // Crear OP tipo M con modalidad flete
      const { id: id_op, nro_op, nro_remito } = VentasModel.crear({
        id_cliente:          clienteId || null,
        cliente_nombre_libre: !clienteId ? clienteNombre : null,
        id_administrativo:   req.session.user.id,
        tipo_op:             'M',
        modalidad:           'flete',
        metodo_pago:         metodoPago || 'efectivo',
        observaciones:       descripcion || '',
        fecha_entrega_planificada: fecha || null,
        domicilio: { calle, altura: numero, sin_numero: !numero },
        detalles: [{
          id_producto:     productoId,
          cantidad_pedida: cantidadNum,
          precio_unitario: Number(precioProducto) || 0,
        }],
      })

      // Asignar chofer y camión si se seleccionaron
      if (idChofer || idCamion) {
        try {
          OperacionesModel.asignar(id_op, {
            id_chofer: idChofer || null,
            id_camion: idCamion || null,
            usuario: req.session.user.id,
          })
        } catch (e) { console.error('asignar chofer/camion:', e) }
      }

      if (esFinalizarAhora) {
        VentasModel.entregar(id_op)
        TransaccionesModel.crear({
          tipo:            'Venta Viaje',
          id_op_encabezado: id_op,
          nro_remito,
          cliente_id:      clienteId || null,
          cliente:         clienteNombre || 'Sin nombre',
          monto:           total,
          descripcion:     `Viaje a ${direccion}`,
          metodo_pago:     metodoPago || 'efectivo',
        })
        if (metodoPago === 'cuenta_corriente' && clienteId) {
          ClientesModel.agregarMovimiento(clienteId, {
            tipo: 'deuda',
            descripcion: `Venta Viaje: ${direccion}`,
            monto: -total,
          })
        }
      }

      req.flash('success', `Viaje OP-${String(nro_op).padStart(4,'0')} ${esFinalizarAhora ? 'finalizado' : 'programado'} correctamente.`)
      res.redirect(`/ventas/${id_op}`)
    } catch (err) {
      console.error(err)
      req.flash('error', 'Error al crear el viaje.')
      res.redirect('/ventas/viaje')
    }
  },

  // ── Detalle ───────────────────────────────────────────────────
  detalle(req, res) {
    try {
      const op = VentasModel.obtener(req.params.id)
      if (!op) { req.flash('error', 'Orden no encontrada.'); return res.redirect('/ventas') }
      res.render('pages/ventas/detalle', {
        titulo: `OP-${String(op.nro_op).padStart(4,'0')}`, op,
        recursos: OperacionesModel.obtenerRecursos(op.id),
        choferesDisp: OperacionesModel.choferesDisponibles(),
        camionesDisp: OperacionesModel.camionesDisponibles(),
        recursosEditable: op.estado !== 'anulado' && op.estado !== 'entregado',
      })
    } catch (err) {
      console.error(err)
      req.flash('error', 'Error al cargar la orden.')
      res.redirect('/ventas')
    }
  },

  // ── Edición de viaje en proceso ───────────────────────────────
  editarViaje(req, res) {
    try {
      const viaje = VentasModel.obtenerViaje(req.params.id)
      if (!viaje) { req.flash('error', 'Viaje no encontrado.'); return res.redirect('/ventas') }
      if (viaje.estado === 'entregado' || viaje.estado === 'anulado') {
        req.flash('error', 'Solo se pueden editar viajes pendientes o despachados.')
        return res.redirect(`/ventas/${req.params.id}`)
      }
      res.render('pages/ventas/editar_viaje', {
        titulo: `Editar OP-${String(viaje.nro_op).padStart(4,'0')}`,
        viaje,
        calle: viaje.calle,
        numero: viaje.numero,
      })
    } catch (err) {
      console.error(err)
      req.flash('error', 'Error al cargar el viaje para editar.')
      res.redirect('/ventas')
    }
  },

  actualizarViaje(req, res) {
    try {
      VentasModel.actualizarViaje(req.params.id, req.body)
      req.flash('success', 'Viaje actualizado.')
      res.redirect(`/ventas/${req.params.id}`)
    } catch (err) {
      console.error(err)
      req.flash('error', err.message || 'Error al actualizar.')
      res.redirect(`/ventas/${req.params.id}/editar`)
    }
  },

  despachar(req, res) {
    try {
      VentasModel.despachar(req.params.id)
      req.flash('success', 'Orden marcada como despachada.')
    } catch (err) {
      console.error(err)
      req.flash('error', 'Error al despachar.')
    }
    res.redirect(`/ventas/${req.params.id}`)
  },

  entregar(req, res) {
    try {
      const op = VentasModel.obtener(req.params.id)
      VentasModel.entregar(req.params.id)
      // Registrar transacción al entregar
      if (op) {
        TransaccionesModel.crear({
          tipo:            op.modalidad === 'flete' ? 'Venta Viaje' : 'Venta Cantera',
          id_op_encabezado: op.id,
          nro_remito:      op.nro_remito,
          cliente_id:      op.id_cliente,
          cliente:         op.cliente_nombre,
          monto:           op.total,
          descripcion:     op.observaciones || '',
          metodo_pago:     op.metodo_pago || 'efectivo',
        })
      }
      req.flash('success', 'Entrega confirmada.')
      res.redirect(`/ventas/${req.params.id}/remito`)
    } catch (err) {
      console.error(err)
      req.flash('error', 'Error al confirmar entrega.')
      res.redirect(`/ventas/${req.params.id}`)
    }
  },

  anular(req, res) {
    try {
      VentasModel.anular(req.params.id)
      req.flash('warning', 'Orden anulada. Stock pendiente liberado.')
    } catch (err) {
      console.error(err)
      req.flash('error', 'Error al anular la orden.')
    }
    res.redirect('/ventas')
  },

  remito(req, res) {
    try {
      const op = VentasModel.obtener(req.params.id)
      if (!op) { req.flash('error', 'Orden no encontrada.'); return res.redirect('/ventas') }
      res.render('pages/ventas/remito', { titulo: `Remito OP-${String(op.nro_op).padStart(4,'0')}`, layout: false, op })
    } catch (err) {
      console.error(err)
      req.flash('error', 'Error al generar el remito.')
      res.redirect(`/ventas/${req.params.id}`)
    }
  },

  // ── API JSON para búsqueda de clientes desde el front ────────
  buscarClientesApi(req, res) {
    try {
      const { id, dni, nombre } = req.query
      if (!id && !dni && !nombre) return res.json([])
      const resultados = ClientesModel.buscar({ id, dni, nombre })
      res.json(resultados.map(c => ({
        id: c.id,
        numero: c.numero,
        nombre: c.nombre,
        apellido: c.apellido || '',
        nombreCompleto: ClientesModel.nombreCompleto(c),
        dni: c.dni,
        telefono: c.telefono || c.tel_whatsapp,
        email: c.email,
        cuentaCorriente: !!c.cuenta_corriente,
      })))
    } catch (err) {
      console.error(err)
      res.status(500).json({ error: 'Error al buscar clientes.' })
    }
  },

  crearClienteApi(req, res) {
    try {
      const { nombre, apellido, dni, telefono, email } = req.body
      if (!nombre || !apellido || !telefono) {
        return res.status(400).json({ error: 'Nombre, apellido y teléfono son obligatorios.' })
      }
      const id = ClientesModel.crear({ nombre, apellido, dni, telefono, email })
      const nuevo = ClientesModel.obtener(id)
      res.json({
        id: nuevo.id,
        numero: nuevo.numero,
        nombre: nuevo.nombre,
        apellido: nuevo.apellido || '',
        nombreCompleto: ClientesModel.nombreCompleto(nuevo),
        dni: nuevo.dni,
        telefono: nuevo.telefono,
        email: nuevo.email,
        cuentaCorriente: !!nuevo.cuenta_corriente,
      })
    } catch (err) {
      console.error(err)
      res.status(500).json({ error: 'Error al crear el cliente.' })
    }
  },
}

module.exports = VentasController
