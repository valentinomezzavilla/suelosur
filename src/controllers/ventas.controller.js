'use strict'
const VentasModel       = require('../models/ventas.model')
const TransaccionesModel = require('../models/transacciones.model')
const ClientesModel     = require('../models/clientes.model')
const OperacionesModel  = require('../models/operaciones.model')
const AsignacionesModel = require('../models/asignaciones.model')
const { query }         = require('../config/db')
const { resolverPeriodo, etiquetaPeriodo } = require('../utils/periodos')
const { textoDestino } = require('../utils/destino')
const ProductosModel    = require('../models/productos.model')
const { cotizarContenedor, MAX_CONTENEDORES_POR_OP } = require('../utils/contenedor')

// Una venta cargada con fecha pasada tiene que impactar en ESA fecha, no en la de
// carga: se usa como fecha de emisión y como fecha de la transacción. Con fecha de
// hoy o futura (un viaje programado) la emisión sigue siendo hoy.
function fechaRetroactiva(fecha) {
  if (!fecha) return null
  const f = String(fecha).slice(0, 10)
  const hoy = new Date().toISOString().slice(0, 10)
  return f < hoy ? f : null
}

// El precio de lista de una venta NUNCA sale de lo que mande el formulario: siempre se
// relee del catálogo según el canal (cantera / viaje), así no importa qué haya llegado
// en el POST (un precio viejo en caché, o alguien tocando el request a mano). Solo se
// aparta de la lista cuando el usuario tildó "Editar" (precio unitario o subtotal).
// Los contenedores traen además sus rangos de precio por día (iguales en los dos canales).
const COLUMNA_PRECIO = { cantera: 'precio_cantera', viaje: 'precio_viaje' }
async function catalogo(canal, idsProducto) {
  const columna = COLUMNA_PRECIO[canal]
  const ids = [...new Set(idsProducto.map(String))].filter(Boolean)
  if (!ids.length) return {}
  const rows = (await query(`SELECT id, nombre, es_contenedor, ${columna} AS precio FROM productos WHERE id = ANY(?)`, [ids])).rows
  const rangos = await ProductosModel.rangosDe(rows.filter(r => r.es_contenedor).map(r => r.id))
  const map = {}
  rows.forEach(r => {
    map[String(r.id)] = {
      nombre: r.nombre,
      precio: Number(r.precio) || 0,
      esContenedor: !!r.es_contenedor,
      rangos: rangos[String(r.id)] || [],
    }
  })
  return map
}

// Renglón de venta de un contenedor: siempre 1, con los días y el precio del rango.
// Devuelve { detalle } o { error }.
function detalleContenedor(idProducto, prod, dias) {
  const cot = cotizarContenedor(prod.rangos, dias)
  if (cot.error) return { error: `${prod.nombre}: ${cot.error}` }
  return {
    detalle: {
      id_producto:     idProducto,
      cantidad_pedida: 1,
      precio_unitario: cot.subtotal,
      dias:            cot.dias,
      precio_dia:      cot.precio_dia,
    },
  }
}

const MSG_UN_CONTENEDOR = `Solo se puede cargar ${MAX_CONTENEDORES_POR_OP} contenedor por operación.`

// Remito cargado a mano al crear la venta (el del talonario). Vacío = se asigna el
// siguiente de la secuencia. Devuelve { nro } o { error }.
async function leerRemito(valor) {
  const txt = String(valor ?? '').trim()
  if (!txt) return { nro: null }
  if (!/^\d{1,8}$/.test(txt) || Number(txt) < 1) return { error: 'El remito tiene que ser un número (hasta 8 dígitos).' }
  const nro = Number(txt)
  const dup = await opConRemito(nro)
  if (dup) return { error: `El remito ${nro} ya está cargado en OP-${String(dup.nro_op).padStart(4, '0')}.` }
  return { nro }
}

// Operación (no anulada) que ya usa ese número de remito
async function opConRemito(nro) {
  return (await query(
    `SELECT nro_op FROM op_encabezado WHERE nro_remito = ? AND estado <> 'anulado' LIMIT 1`, [nro])).rows[0]
}

const VentasController = {

  async index(req, res) {
    try {
      const { estado, id_cliente, q, sort, dir, page, preset, fechaDesde, fechaHasta, mes } = req.query
      const periodo = resolverPeriodo({ preset, desde: fechaDesde, hasta: fechaHasta, mes })

      const filtrosBase = { estado, id_cliente, q, fechaDesde: periodo.desde, fechaHasta: periodo.hasta }
      const paginacion = await VentasModel.listar({ ...filtrosBase, sort, dir, page: parseInt(page) || 1, limit: 20 })
      const clientes   = await VentasModel.listarClientes()
      const resumen    = await VentasModel.contarPorEstado()
      const metricas   = await VentasModel.resumen(filtrosBase)

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
  async cantera(req, res) {
    try {
      const productos = await VentasModel.listarProductos()
      res.render('pages/ventas/cantera', {
        titulo: 'Venta en Cantera',
        productos,
        scripts: ['/js/buscarCliente.js', '/js/formValidation.js', '/js/remitoCheck.js', '/js/ventasCantera.js'],
      })
    } catch (err) {
      console.error(err)
      req.flash('error', 'Error al cargar productos.')
      res.redirect('/ventas')
    }
  },

  async finalizarCantera(req, res) {
    try {
      const { clienteId, clienteNombre, items, metodoPago, precioTotal, fecha } = req.body
      const fechaRetro = fechaRetroactiva(fecha)
      const clienteIdClean = (clienteId && clienteId.trim()) || null
      if (metodoPago === 'cuenta_corriente') {
        const errCC = await ClientesModel.errorCuentaCorriente(clienteIdClean)
        if (errCC) { req.flash('error', errCC); return res.redirect('/ventas/cantera') }
      }
      const remito = await leerRemito(req.body.remito)
      if (remito.error) { req.flash('error', remito.error); return res.redirect('/ventas/cantera') }
      let carrito = []
      try { carrito = JSON.parse(items || '[]') } catch (_) {}
      if (!carrito.length) { req.flash('error', 'El carrito está vacío.'); return res.redirect('/ventas/cantera') }

      // Precio cantera siempre desde el catálogo, nunca el que mandó el formulario.
      const cat = await catalogo('cantera', carrito.map(p => p.id))
      if (carrito.some(p => !cat[String(p.id)])) {
        req.flash('error', 'Hay un producto del carrito que ya no existe.'); return res.redirect('/ventas/cantera')
      }
      // Contenedor: uno solo por operación, cantidad 1, precio por días según el rango
      if (carrito.filter(p => cat[String(p.id)].esContenedor).length > MAX_CONTENEDORES_POR_OP) {
        req.flash('error', MSG_UN_CONTENEDOR); return res.redirect('/ventas/cantera')
      }
      const detalles = []
      for (const p of carrito) {
        const prod = cat[String(p.id)]
        if (prod.esContenedor) {
          const r = detalleContenedor(p.id, prod, Number(p.dias))
          if (r.error) { req.flash('error', r.error); return res.redirect('/ventas/cantera') }
          detalles.push({ ...r.detalle, nombre: prod.nombre })
        } else {
          const cantidad = Number(p.cantidad)
          if (!(cantidad > 0)) { req.flash('error', `Cantidad inválida para ${prod.nombre}.`); return res.redirect('/ventas/cantera') }
          detalles.push({ id_producto: p.id, cantidad_pedida: cantidad, precio_unitario: prod.precio, nombre: prod.nombre })
        }
      }

      const total  = precioTotal ? Number(precioTotal) : detalles.reduce((a, d) => a + d.precio_unitario * d.cantidad_pedida, 0)
      const nombre = clienteNombre || 'Particular'
      const obsUser = (req.body.observaciones || '').trim()
      const detalleCarrito = detalles.map(d => d.dias != null ? `${d.nombre} (${d.dias} días) x1` : `${d.nombre} x${d.cantidad_pedida}`).join(', ')
      const desc   = obsUser ? `${detalleCarrito} — ${obsUser}` : detalleCarrito

      const { id: id_op, nro_op, nro_remito } = await VentasModel.crear({
        id_cliente:          clienteIdClean,
        cliente_nombre_libre: !clienteIdClean ? nombre : null,
        id_administrativo:   req.session.user.id,
        tipo_op:             'M',
        modalidad:           'deposito',
        metodo_pago:         metodoPago || 'efectivo',
        observaciones:       desc,
        detalles,
        fecha_emision:       fechaRetro,
        monto_total:         total,
        nro_remito:          remito.nro,
      })
      await require('../models/facturacion.model').marcarAlCrear(id_op, req.body.paraFacturar, total)

      await VentasModel.entregar(id_op)

      await TransaccionesModel.crear({
        tipo:            'Venta Cantera',
        id_op_encabezado: id_op,
        nro_remito,
        cliente_id:      clienteIdClean,
        cliente:         nombre,
        monto:           total,
        descripcion:     desc,
        metodo_pago:     metodoPago || 'efectivo',
        fecha:           fechaRetro,
      })

      // A cuenta corriente: el cargo en la cuenta del cliente
      await VentasModel.sincronizarCargoCC(id_op)

      res.redirect(`/ventas/cantera/confirmacion?tipo=cantera&cliente=${encodeURIComponent(nombre)}&total=${total}&remito=${nro_remito}`)
    } catch (err) {
      console.error(err)
      req.flash('error', 'Error al finalizar la venta.')
      res.redirect('/ventas/cantera')
    }
  },

  async confirmacionCantera(req, res) {
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
  async viaje(req, res) {
    try {
      const productos  = await VentasModel.listarProductos()
      const viajesHoy  = await VentasModel.listarViajesPendientesHoy()
      const viajesTodos = await VentasModel.listarViajesPendientes()
      const choferes = (await query(`
        SELECT e.id, e.nombre, e.apellido FROM empleados e
        WHERE e.es_chofer = 1 AND e.activo = 1
        ORDER BY e.apellido, e.nombre
      `)).rows
      const camiones = (await query(`
        SELECT v.id, v.numero_interno, v.patente, v.nombre, v.marca, v.modelo
        FROM flota_vehiculos v
        WHERE v.activo = 1
          AND COALESCE(v.estado_operativo, 'disponible') NOT IN ('en_mantenimiento','fuera_servicio','inactivo')
          AND (v.actividad IS NULL OR v.actividad = '' OR v.actividad = 'ventas')
        ORDER BY v.numero_interno, v.nombre
      `)).rows
      const zonas = await require('../models/zonas.model').listarActivas()
      res.render('pages/ventas/viaje', {
        titulo: 'Venta con Viaje',
        productos, viajesHoy, viajesTodos, choferes, camiones, zonas,
        scripts: ['/js/buscarCliente.js', '/js/formValidation.js', '/js/remitoCheck.js', '/js/ventasViaje.js'],
      })
    } catch (err) {
      console.error(err)
      req.flash('error', 'Error al cargar la página.')
      res.redirect('/ventas')
    }
  },

  // ── API: ¿ya existe ese remito? (aviso en vivo en los formularios de venta) ──
  async apiRemitoExiste(req, res) {
    try {
      const nro = Number(req.params.nro)
      if (!Number.isInteger(nro) || nro < 1) return res.json({ existe: false })
      const dup = await opConRemito(nro)
      res.json(dup ? { existe: true, op: `OP-${String(dup.nro_op).padStart(4, '0')}` } : { existe: false })
    } catch (err) { console.error(err); res.status(500).json({ error: 'Error' }) }
  },

  // ── API: asignación chofer ↔ camión ────────────────────────────
  // Dado un id de camión, devuelve el chofer que lo tiene asignado (si hay)
  async apiChoferDeCamion(req, res) {
    try {
      const chofer = await AsignacionesModel.choferDeRecurso('camion', req.params.idCamion)
      if (!chofer) return res.json(null)
      return res.json({
        id: chofer.id_empleado,
        nombre: `${chofer.nombre} ${chofer.apellido || ''}`.trim(),
        legajo: chofer.legajo,
      })
    } catch (err) { console.error(err); res.status(500).json({ error: 'Error' }) }
  },

  // Dado un id de empleado/chofer, devuelve el camión que tiene asignado (si hay)
  async apiCamionDeChofer(req, res) {
    try {
      const asig = await AsignacionesModel.recursoActivo(req.params.idChofer, 'camion')
      if (!asig) return res.json(null)
      const camion = (await query(`SELECT id, numero_interno, patente, nombre, marca, modelo FROM flota_vehiculos WHERE id = ?`, [asig.recurso_id])).rows[0]
      return res.json(camion || null)
    } catch (err) { console.error(err); res.status(500).json({ error: 'Error' }) }
  },

  async crearViaje(req, res) {
    try {
      const {
        clienteId, clienteNombre, telefono, fecha, hora, calle, numero,
        productoId, cantidad, precioFlete, precioTotal, editarSubtotal, subtotalManual,
        metodoPago, descripcion, finalizarAhora,
        idChofer, idCamion, zona, obra,
      } = req.body

      // Destino: se exige dirección (calle) u obra, al menos uno.
      if (!(calle || '').trim() && !(obra || '').trim()) {
        req.flash('error', 'Cargá la dirección (calle) o la obra. Al menos uno es obligatorio.')
        return res.redirect(req.get('Referrer') || '/ventas')
      }
      if (metodoPago === 'cuenta_corriente') {
        const errCC = await ClientesModel.errorCuentaCorriente(clienteId || null)
        if (errCC) { req.flash('error', errCC); return res.redirect('/ventas/viaje') }
      }
      const remito = await leerRemito(req.body.remito)
      if (remito.error) { req.flash('error', remito.error); return res.redirect('/ventas/viaje') }

      const esFinalizarAhora = finalizarAhora === 'true'
      const destino   = textoDestino({ calle, numero, obra })
      const flete     = Math.max(0, Number(precioFlete) || 0)

      // Precio viaje siempre desde el catálogo, nunca el que mandó el formulario.
      const prod = (await catalogo('viaje', [productoId]))[String(productoId)]
      if (!prod) { req.flash('error', 'Elegí un producto.'); return res.redirect('/ventas/viaje') }
      let detalle
      if (prod.esContenedor) {
        // Contenedor: cantidad 1 siempre; lo que se carga son los días
        const r = detalleContenedor(productoId, prod, Number(req.body.dias))
        if (r.error) { req.flash('error', r.error); return res.redirect('/ventas/viaje') }
        detalle = r.detalle
      } else {
        detalle = { id_producto: productoId, cantidad_pedida: Number(cantidad) || 1, precio_unitario: prod.precio }
      }
      // Salvo que se haya tildado "Editar" en el subtotal o en el precio unitario: ahí
      // manda lo que se cargó (se edita uno u otro; si llegaran los dos, gana el subtotal).
      const subtotalEditado = Number(subtotalManual)
      const precioEditado   = Number(req.body.precioUnitarioManual)
      if (editarSubtotal === '1' && String(subtotalManual ?? '').trim() !== '' && subtotalEditado >= 0) {
        detalle.precio_unitario = subtotalEditado / detalle.cantidad_pedida
        if (detalle.dias) detalle.precio_dia = subtotalEditado / detalle.dias
      } else if (req.body.editarPrecio === '1' && String(req.body.precioUnitarioManual ?? '').trim() !== '' && precioEditado >= 0) {
        // Precio unitario editado: subtotal = precio × cantidad (contenedor: precio por día × días)
        if (detalle.dias) {
          detalle.precio_dia      = precioEditado
          detalle.precio_unitario = precioEditado * detalle.dias
        } else {
          detalle.precio_unitario = precioEditado
        }
      }
      // Total pactado: el que manda el formulario (puede estar editado a mano);
      // si no llegó, productos + flete.
      const total = String(precioTotal ?? '').trim() !== ''
        ? Math.max(0, Number(precioTotal) || 0)
        : detalle.precio_unitario * detalle.cantidad_pedida + flete

      // Crear OP tipo M con modalidad flete
      const { id: id_op, nro_op, nro_remito } = await VentasModel.crear({
        id_cliente:          clienteId || null,
        cliente_nombre_libre: !clienteId ? clienteNombre : null,
        id_administrativo:   req.session.user.id,
        tipo_op:             'M',
        modalidad:           'flete',
        metodo_pago:         metodoPago || 'efectivo',
        observaciones:       descripcion || '',
        fecha_entrega_planificada: fecha || null,
        fecha_emision:       fechaRetroactiva(fecha),
        hora_planificada:    hora || null,
        zona:                zona || null,
        obra:                obra || null,
        domicilio: { calle, altura: numero, sin_numero: !numero },
        precio_flete:        flete,
        monto_total:         total,
        nro_remito:          remito.nro,
        detalles: [detalle],
      })
      await require('../models/facturacion.model').marcarAlCrear(id_op, req.body.paraFacturar, total)
      // A cuenta corriente: el cargo aparece en la cuenta del cliente desde que se registra
      // la venta, aunque el viaje quede programado.
      await VentasModel.sincronizarCargoCC(id_op)

      // Asignar chofer y camión si se seleccionaron
      if (idChofer || idCamion) {
        try {
          const { advertencias } = await OperacionesModel.asignar(id_op, {
            id_chofer: idChofer || null,
            id_camion: idCamion || null,
            usuario: req.session.user.id,
          })
          ;(advertencias || []).forEach(a => req.flash('warning', a))
        } catch (e) {
          console.error('asignar chofer/camion:', e)
          req.flash('warning', e.message || 'No se pudo asignar el chofer/camión.')
        }
      }

      if (esFinalizarAhora) {
        await VentasModel.entregar(id_op)
        await TransaccionesModel.crear({
          tipo:            'Venta Viaje',
          id_op_encabezado: id_op,
          nro_remito,
          cliente_id:      clienteId || null,
          cliente:         clienteNombre || 'Sin nombre',
          monto:           total,
          descripcion:     `Viaje a ${destino}`,
          metodo_pago:     metodoPago || 'efectivo',
          fecha:           fechaRetroactiva(fecha),
        })
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
  async detalle(req, res) {
    try {
      const op = await VentasModel.obtener(req.params.id)
      if (!op) { req.flash('error', 'Orden no encontrada.'); return res.redirect('/ventas') }
      const recursos = await OperacionesModel.obtenerRecursos(op.id)
      const choferesDisp = await OperacionesModel.choferesDisponibles()
      if (recursos?.id_chofer && !choferesDisp.some(c => c.id === recursos.id_chofer)) {
        const extra = await OperacionesModel.obtenerChofer(recursos.id_chofer)
        if (extra) choferesDisp.push(extra)
      }
      const solapamiento = req.session.solapamiento?.opId === String(op.id) ? req.session.solapamiento : null
      if (solapamiento) delete req.session.solapamiento
      res.render('pages/ventas/detalle', {
        titulo: `OP-${String(op.nro_op).padStart(4,'0')}`, op,
        facturacion: await require('../models/facturacion.model').estadoOp(op.id),
        recursos, choferesDisp, solapamiento,
        camionesDisp: await OperacionesModel.camionesDisponibles('ventas'),
        recursosEditable: op.estado !== 'anulado' && op.estado !== 'entregado',
      })
    } catch (err) {
      console.error(err)
      req.flash('error', 'Error al cargar la orden.')
      res.redirect('/ventas')
    }
  },

  // ── Edición de viaje en proceso ───────────────────────────────
  async editarViaje(req, res) {
    try {
      const viaje = await VentasModel.obtenerViaje(req.params.id)
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
        zonas: await require('../models/zonas.model').listarActivas(),
      })
    } catch (err) {
      console.error(err)
      req.flash('error', 'Error al cargar el viaje para editar.')
      res.redirect('/ventas')
    }
  },

  async actualizarViaje(req, res) {
    try {
      await VentasModel.actualizarViaje(req.params.id, req.body)
      req.flash('success', 'Viaje actualizado.')
      res.redirect(`/ventas/${req.params.id}`)
    } catch (err) {
      console.error(err)
      req.flash('error', err.message || 'Error al actualizar.')
      res.redirect(`/ventas/${req.params.id}/editar`)
    }
  },

  async despachar(req, res) {
    try {
      await VentasModel.despachar(req.params.id)
      req.flash('success', 'Orden marcada como despachada.')
    } catch (err) {
      console.error(err)
      req.flash('error', 'Error al despachar.')
    }
    res.redirect(`/ventas/${req.params.id}`)
  },

  async entregar(req, res) {
    try {
      const op = await VentasModel.obtener(req.params.id)
      if (!op) { req.flash('error', 'Orden no encontrada.'); return res.redirect('/ventas') }
      // Un doble envío del formulario no puede generar otra transacción ni otro cargo
      if (!['pendiente', 'despachado'].includes(op.estado)) {
        req.flash('warning', 'La orden ya estaba entregada o anulada.')
        return res.redirect(`/ventas/${op.id}`)
      }
      await VentasModel.entregar(op.id)
      const esViaje = op.modalidad === 'flete'
      const destino = esViaje ? textoDestino({ calle: op.domicilio_calle, numero: op.domicilio_altura, obra: op.obra }) : ''
      // Registrar transacción al entregar
      if (!await TransaccionesModel.existePorOperacion(op.id)) {
        await TransaccionesModel.crear({
          tipo:            esViaje ? 'Venta Viaje' : 'Venta Cantera',
          id_op_encabezado: op.id,
          nro_remito:      op.nro_remito,
          cliente_id:      op.id_cliente,
          cliente:         op.cliente_nombre,
          monto:           op.total,
          // En los viajes el destino va primero, para que la transacción diga adónde se llevó
          descripcion:     esViaje
            ? [destino ? `Viaje a ${destino}` : 'Venta con viaje', op.observaciones].filter(Boolean).join(' — ')
            : (op.observaciones || ''),
          metodo_pago:     op.metodo_pago || 'efectivo',
        })
      }
      // A cuenta corriente: el cargo ya existe desde el alta; esto lo confirma (no duplica)
      await VentasModel.sincronizarCargoCC(op.id)
      req.flash('success', 'Entrega confirmada.')
      res.redirect(`/ventas/${req.params.id}/remito`)
    } catch (err) {
      console.error(err)
      req.flash('error', 'Error al confirmar entrega.')
      res.redirect(`/ventas/${req.params.id}`)
    }
  },

  async anular(req, res) {
    try {
      await VentasModel.anular(req.params.id)
      req.flash('warning', 'Orden anulada. Stock pendiente liberado.')
    } catch (err) {
      console.error(err)
      req.flash('error', 'Error al anular la orden.')
    }
    res.redirect('/ventas')
  },

  async remito(req, res) {
    try {
      const op = await VentasModel.obtener(req.params.id)
      if (!op) { req.flash('error', 'Orden no encontrada.'); return res.redirect('back') }

      // Si es chofer, solo puede ver remitos de operaciones asignadas a él
      if (req.session.user?.rol === 'chofer') {
        const emp = (await query(
          `SELECT id FROM empleados WHERE id_usuario = ? AND activo = 1`,
          [req.session.user.id]
        )).rows[0]
        if (!emp || Number(op.id_chofer) !== Number(emp.id)) {
          req.flash('error', 'No tenés permiso para ver este remito.')
          return res.redirect('/hoja-de-ruta')
        }
      }

      res.render('pages/ventas/remito', { titulo: `Remito OP-${String(op.nro_op).padStart(4,'0')}`, layout: false, op })
    } catch (err) {
      console.error(err)
      req.flash('error', 'Error al generar el remito.')
      res.redirect('back')
    }
  },

  // ── Libro de ventas (reporte a nivel de renglón) ─────────────
  async libroForm(req, res) {
    res.render('pages/ventas/libro', { titulo: 'Libro de ventas', filtros: req.query })
  },

  async libroPDF(req, res) {
    try {
      const ReportesModel = require('../models/reportes.model')
      const { generarLibroVentasPDF } = require('../utils/pdfLibroVentas')
      const { fmtFecha } = require('../utils/fecha')
      const { desde, hasta, clienteId } = req.query
      const { filas, total } = await ReportesModel.libroVentas({ desde: desde || null, hasta: hasta || null, clienteId: clienteId || null })
      let clienteLabel = null
      if (clienteId) {
        const cli = await require('../models/clientes.model').obtener(clienteId)
        clienteLabel = cli ? `${cli.nombre || ''} ${cli.apellido || ''}`.trim() : null
      }
      const periodoLabel = [desde && `desde ${fmtFecha(desde)}`, hasta && `hasta ${fmtFecha(hasta)}`].filter(Boolean).join(' ') || 'Histórico completo'
      return generarLibroVentasPDF(res, {
        filas, total, periodoLabel, clienteLabel,
        nombreArchivo: clienteId ? `libro-ventas-cliente-${clienteId}` : 'libro-ventas',
      })
    } catch (err) { console.error(err); req.flash('error', 'Error al generar el libro de ventas.'); res.redirect('/ventas/libro') }
  },

  async libroExcel(req, res) {
    try {
      const ReportesModel = require('../models/reportes.model')
      const { generarExcel } = require('../utils/excel')
      const { fmtFecha } = require('../utils/fecha')
      const { desde, hasta, clienteId } = req.query
      const { filas, total } = await ReportesModel.libroVentas({ desde: desde || null, hasta: hasta || null, clienteId: clienteId || null })
      const columnas = [
        { header: 'Fecha', key: 'fecha', width: 12 },
        { header: 'Remito', key: 'nro_remito', width: 10 },
        { header: 'Cant.', key: 'cantidad', width: 8 },
        { header: 'Cód', key: 'cod', width: 8 },
        { header: 'Material', key: 'material', width: 24 },
        { header: 'Cliente', key: 'cliente', width: 28 },
        { header: 'Obra', key: 'obra', width: 28 },
        { header: 'Precio unit.', key: 'precio_unit', width: 14, money: true },
        { header: 'Importe', key: 'importe', width: 14, money: true },
      ]
      const filasX = filas.map(f => ({ ...f, fecha: fmtFecha(f.fecha) }))
      filasX.push({ material: 'TOTAL', importe: total })
      return generarExcel(res, { titulo: 'Libro de ventas', columnas, filas: filasX, nombreArchivo: clienteId ? `libro-ventas-cliente-${clienteId}` : 'libro-ventas' })
    } catch (err) { console.error(err); req.flash('error', 'Error al generar el Excel.'); res.redirect('/ventas/libro') }
  },

  // ── API JSON para búsqueda de clientes desde el front ────────
  async buscarClientesApi(req, res) {
    try {
      const { id, dni, nombre } = req.query
      if (!id && !dni && !nombre) return res.json([])
      const resultados = await ClientesModel.buscar({ id, dni, nombre })
      res.json(resultados.map(c => ({
        id: c.id,
        numero: c.numero,
        nombre: c.nombre,
        apellido: c.apellido || '',
        nombreCompleto: ClientesModel.nombreCompleto(c),
        dni: c.dni,
        telefono: c.telefono || c.tel_whatsapp,
        email: c.email,
        zona: c.zona || '',
        domicilio: c.domicilio_ppal || '',
        cuentaCorriente: !!c.cuenta_corriente,
      })))
    } catch (err) {
      console.error(err)
      res.status(500).json({ error: 'Error al buscar clientes.' })
    }
  },

  async crearClienteApi(req, res) {
    try {
      const { nombre, apellido, dni, telefono, email } = req.body
      if (!nombre || !apellido || !telefono) {
        return res.status(400).json({ error: 'Nombre, apellido y teléfono son obligatorios.' })
      }
      const id = await ClientesModel.crear({ nombre, apellido, dni, telefono, email })
      const nuevo = await ClientesModel.obtener(id)
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
