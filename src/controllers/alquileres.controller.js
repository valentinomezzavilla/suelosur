'use strict'
const AlquileresModel        = require('../models/alquileres.model')
const { hoyISO } = require('../utils/fecha')
const TransaccionesModel     = require('../models/transacciones.model')
const ClientesModel          = require('../models/clientes.model')
const OperacionesModel        = require('../models/operaciones.model')
const { plazoPorCuentaCorriente, PLAZO_CUENTA_CORRIENTE, PLAZO_ESTANDAR, calcularPlazoAlquiler } = require('../config/alquiler')
const { leerContenedoresDelForm, leerMontosPorOp } = require('../utils/contenedoresForm')
const { textoDestino, numeroSinRepetirCalle } = require('../utils/destino')
const { diasHabilesEntre } = require('../utils/diasHabiles')
const { leerRemito } = require('../utils/remito')

// Geocodifica la dirección del alquiler sin hacer esperar al usuario: si Nominatim
// falla o tarda, el alquiler ya quedó creado y aparece en "sin ubicar" del mapa.
function ubicarEnSegundoPlano(id_op) {
  AlquileresModel.ubicar(id_op).catch(e => console.error('Ubicar alquiler:', e.message))
}

// Estado del alquiler para el color del pin en el mapa. "Por finalizar" usa el mismo
// criterio que la tarjeta del listado (vence hoy o mañana; al vencer pasa solo a
// 'pendiente_retiro' por autoVencerAlquileres).
function estadoMapa(f) {
  if (f.op_estado === 'pendiente' || f.op_estado === 'despachado') return 'pendiente'
  if (f.contenedor_estado === 'pendiente_retiro') return 'a_retirar'
  if (f.dias_restantes != null && f.dias_restantes <= 1) return 'por_finalizar'
  return 'en_curso'
}

// Coordenadas dentro de Argentina continental (para la ubicación cargada a mano).
function coordenadaValida(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng)
    && lat >= -55.5 && lat <= -21 && lng >= -74 && lng <= -53
}

const AlquileresController = {

  async index(req, res) {
    try {
      await AlquileresModel.autoVencerAlquileres().catch(e => console.error('autoVencer:', e.message))
      const q = req.query.q || ''
      const grupos = await AlquileresModel.listarPorEstado({ q })
      res.render('pages/alquileres/index', { titulo: 'Alquileres — Contenedores', grupos, filtros: { q } })
    } catch (err) {
      console.error(err)
      req.flash('error', 'Error al cargar los alquileres.')
      res.redirect('/contenedores')
    }
  },

  async nuevo(req, res) {
    try {
      const [{ disponibles, porLiberar }, choferesDisp, camionesDisp, zonas] = await Promise.all([
        AlquileresModel.contenedoresDisponibles(),
        OperacionesModel.choferesDisponibles(),
        OperacionesModel.camionesDisponibles('contenedores'),
        require('../models/zonas.model').listarActivas(),
      ])
      res.render('pages/alquileres/nuevo', {
        titulo: 'Nuevo Alquiler de Contenedor',
        disponibles, porLiberar, choferesDisp, camionesDisp, zonas,
        configPlazos: { cuenta_corriente: PLAZO_CUENTA_CORRIENTE, estandar: PLAZO_ESTANDAR },
        scripts: ['/js/buscarCliente.js', '/js/formValidation.js', '/js/remitoCheck.js', '/js/alquilerService.js'],
      })
    } catch (err) {
      console.error(err)
      req.flash('error', 'Error al cargar el formulario.')
      res.redirect('/alquileres/contenedores')
    }
  },

  async crear(req, res) {
    try {
      const { clienteId, calle, numero: numeroForm, zona_entrega, fechaInicio, fechaFin, precio_alquiler, id_contenedor, metodoPago, observaciones, alquiler_actual_id, id_chofer, id_camion, obra, remito } = req.body
      const clienteIdClean = (clienteId && clienteId.trim()) || null
      if (!clienteIdClean) {
        req.flash('error', 'Seleccioná un cliente.')
        return res.redirect('/alquileres/contenedores/nuevo')
      }
      // El precio siempre se carga a mano: no hay tarifa fija/automática.
      const precioAlquilerNum = parseFloat(precio_alquiler)
      if (!precio_alquiler || isNaN(precioAlquilerNum) || precioAlquilerNum <= 0) {
        req.flash('error', 'Ingresá el precio del alquiler.')
        return res.redirect('/alquileres/contenedores/nuevo')
      }
      const remitoLeido = await leerRemito(remito)
      if (remitoLeido.error) { req.flash('error', remitoLeido.error); return res.redirect('/alquileres/contenedores/nuevo') }
      if (metodoPago === 'cuenta_corriente') {
        const errCC = await ClientesModel.errorCuentaCorriente(clienteIdClean)
        if (errCC) { req.flash('error', errCC); return res.redirect('/alquileres/contenedores/nuevo') }
      }
      if (metodoPago === 'saldo_a_favor') {
        const errSaldo = await ClientesModel.errorSaldoFavor(clienteIdClean)
        if (errSaldo) { req.flash('error', errSaldo); return res.redirect('/alquileres/contenedores/nuevo') }
      }

      // Destino: se exige dirección (calle) u obra, al menos uno.
      if (!(calle || '').trim() && !(obra || '').trim()) {
        req.flash('error', 'Cargá la dirección (calle) o la obra. Al menos uno es obligatorio.')
        return res.redirect('/alquileres/contenedores/nuevo')
      }

      const numero = numeroSinRepetirCalle(calle, numeroForm)
      const domicilio_entrega = `${calle || ''} ${numero}`.trim()
      // Carga histórica: un alquiler viejo que puede haber terminado o seguir en curso.
      const esHistorico = req.body.finalizado === '1' || req.body.finalizado === 'on'
      const historicoEnCurso = esHistorico && req.body.estado_historico === 'en_curso'
      // Alquiler sin fecha de fin: o no se conoce, o el contenedor queda en el
      // domicilio por tiempo indeterminado. Los históricos en curso nunca la tienen.
      const sinFechaFin = historicoEnCurso
        || req.body.sin_fecha_fin === '1' || req.body.sin_fecha_fin === 'on'
      // Inicio anterior a hoy = el alquiler ya venía en curso, se carga como entregado.
      const hoy = hoyISO()
      const esEnCurso = historicoEnCurso
        || (!esHistorico && !!fechaInicio && String(fechaInicio).slice(0, 10) < hoy)
      const fechaFinReal = sinFechaFin ? null : (fechaFin || null)

      // El plazo lo fija que el cliente tenga cuenta corriente habilitada (la fecha de
      // fin del formulario es el reflejo de esa regla). Se calcula desde las fechas
      // cargadas cuando la carga es histórica o cuando se pidió editar el fin a mano.
      // NULL = alquiler sin fecha de fin, sigue en curso por tiempo indeterminado.
      const fechaFinManual = req.body.editar_fecha_fin === '1' || req.body.editar_fecha_fin === 'on'
      const cliente = await ClientesModel.obtener(clienteIdClean)
      const tieneCC = !!cliente?.cuenta_corriente
      // Dejar el alquiler sin fecha de fin solo se permite si el cliente tiene cuenta
      // corriente o si el alquiler ya venía en curso (arrancó antes de hoy).
      if (sinFechaFin && !esHistorico && !tieneCC && !esEnCurso) {
        req.flash('error', 'Solo los clientes con cuenta corriente pueden quedar sin fecha de fin. Para un alquiler que ya venía en curso, cargá una fecha de inicio anterior a hoy.')
        return res.redirect('/alquileres/contenedores/nuevo')
      }
      // Plazo en días hábiles según las reglas del alta (ver calcularPlazoAlquiler).
      const rPlazo = calcularPlazoAlquiler({ fechaInicio, fechaFin, sinFechaFin, esHistorico, fechaFinManual, tieneCC })
      if (rPlazo.error) {
        req.flash('error', rPlazo.error)
        return res.redirect('/alquileres/contenedores/nuevo')
      }
      const plazo_alquiler = rPlazo.plazo

      // ── Varios contenedores: alquiler agrupado (una OP por contenedor) ──
      const seleccion = leerContenedoresDelForm(req.body)
      if (seleccion.error) {
        req.flash('error', seleccion.error)
        return res.redirect('/alquileres/contenedores/nuevo')
      }
      if (seleccion.contenedores.length >= 2) {
        if (esHistorico) {
          req.flash('error', 'La carga histórica es de a un contenedor por alquiler.')
          return res.redirect('/alquileres/contenedores/nuevo')
        }
        if (alquiler_actual_id) {
          req.flash('error', 'El próximo alquiler encadenado ("próximos a finalizar") es de a un contenedor.')
          return res.redirect('/alquileres/contenedores/nuevo')
        }
        // Cada contenedor puede traer precio y fecha de fin propios; vacíos = los generales.
        const contenedores = []
        for (const c of seleccion.contenedores) {
          const precio = c.precio !== '' ? parseFloat(c.precio) : precioAlquilerNum
          if (!(precio > 0)) {
            req.flash('error', 'Revisá el precio de cada contenedor: tiene que ser mayor a cero.')
            return res.redirect('/alquileres/contenedores/nuevo')
          }
          const rp = calcularPlazoAlquiler({
            fechaInicio, fechaFin: c.fin || fechaFin, sinFechaFin, esHistorico: false,
            fechaFinManual: fechaFinManual || !!c.fin, tieneCC,
          })
          if (rp.error) {
            req.flash('error', rp.error)
            return res.redirect('/alquileres/contenedores/nuevo')
          }
          contenedores.push({ id_contenedor: c.id_contenedor, precio_alquiler: precio, plazo_alquiler: rp.plazo })
        }
        const cobroModo = req.body.cobro_modo === 'alquiler' ? 'alquiler' : 'contenedor'
        const grupo = await AlquileresModel.crearGrupo({
          cobro_modo: cobroModo, en_curso: esEnCurso, contenedores, nro_remito: remitoLeido.nro,
          id_cliente: clienteIdClean, id_administrativo: req.session.user.id,
          domicilio_entrega, domicilio_calle: calle, domicilio_numero: numero, zona_entrega,
          metodo_pago: metodoPago, observaciones, obra, fecha_inicio: fechaInicio || null,
          id_chofer: id_chofer || null, id_camion: id_camion || null,
        })
        const FacturacionModel = require('../models/facturacion.model')
        for (const op of grupo.ops) await FacturacionModel.marcarAlCrear(op.id, req.body.paraFacturar, op.precio_alquiler)
        // Se geocodifica una sola vez; ubicar copia las coordenadas al resto del grupo.
        ubicarEnSegundoPlano(grupo.ops[0].id)
        const nros = grupo.ops.map(o => 'OP-' + String(o.nro_op).padStart(4, '0')).join(', ')
        req.flash('success', `Alquiler de ${grupo.ops.length} contenedores ${esEnCurso ? 'cargado como en curso' : 'creado'}: ${nros}. Cobro por ${cobroModo}.`)
        return res.redirect('/alquileres/contenedores')
      }

      // ── Carga histórica: alquiler ya finalizado (ingreso + historial, sin contenedor) ──
      if (esHistorico && !historicoEnCurso) {
        if (!fechaInicio) {
          req.flash('error', 'Indicá la fecha de inicio del alquiler.')
          return res.redirect('/alquileres/contenedores/nuevo')
        }
        const result = await AlquileresModel.crearFinalizado({
          id_cliente: clienteIdClean, id_administrativo: req.session.user.id,
          domicilio_entrega, domicilio_calle: calle, domicilio_numero: numero,
          zona_entrega, plazo_alquiler, precio_alquiler,
          metodo_pago: metodoPago, observaciones, obra,
          fecha_inicio: fechaInicio || null, fecha_fin: fechaFinReal,
          nro_remito: remitoLeido.nro,
        })
        const monto = parseFloat(precio_alquiler) || 0
        const destinoTxt = textoDestino({ domicilio: domicilio_entrega, obra })
        await require('../models/facturacion.model').marcarAlCrear(result.id, req.body.paraFacturar, monto)
        await TransaccionesModel.crear({
          tipo: 'Alquiler', id_op_encabezado: result.id, nro_remito: result.nro_remito,
          cliente_id: clienteIdClean, cliente: result.cliente_nombre, monto,
          descripcion: `Alquiler contenedor (histórico)${destinoTxt ? ' — ' + destinoTxt : ''}`,
          metodo_pago: metodoPago || 'efectivo',
          fecha: fechaFinReal || fechaInicio || null,
        })
        if (metodoPago === 'cuenta_corriente' && clienteIdClean) {
          await ClientesModel.agregarMovimiento(clienteIdClean, {
            tipo: 'deuda',
            descripcion: `Alquiler contenedor (histórico) OP-${String(result.nro_op).padStart(4, '0')}`,
            monto: -monto,
            id_op_encabezado: result.id,
          })
        }
        req.flash('success', `Alquiler finalizado OP-${String(result.nro_op).padStart(4, '0')} cargado (histórico).`)
        return res.redirect('/alquileres/contenedores')
      }

      // ── Alquiler que ya venía en curso: se carga entregado y ocupando el contenedor ──
      if (esEnCurso && !alquiler_actual_id) {
        if (!fechaInicio) {
          req.flash('error', 'Indicá la fecha de inicio del alquiler.')
          return res.redirect('/alquileres/contenedores/nuevo')
        }
        if (!id_contenedor) {
          req.flash('error', 'Elegí el contenedor que está en el domicilio del cliente.')
          return res.redirect('/alquileres/contenedores/nuevo')
        }
        const result = await AlquileresModel.crearEnCurso({
          id_cliente: clienteIdClean, id_administrativo: req.session.user.id,
          domicilio_entrega, domicilio_calle: calle, domicilio_numero: numero,
          zona_entrega, plazo_alquiler, precio_alquiler,
          id_contenedor: id_contenedor || null, metodo_pago: metodoPago,
          observaciones, obra, fecha_inicio: fechaInicio,
          nro_remito: remitoLeido.nro,
        })
        await require('../models/facturacion.model').marcarAlCrear(result.id, req.body.paraFacturar, parseFloat(precio_alquiler) || 0)
        ubicarEnSegundoPlano(result.id)
        // El alquiler sigue abierto: el ingreso se genera recién al retirar el contenedor.
        req.flash('success', `Alquiler OP-${String(result.nro_op).padStart(4, '0')} cargado como en curso desde el ${fechaInicio}. Se cobra al retirar el contenedor.`)
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
          fecha_entrega_planificada: fechaInicio || null,
          nro_remito: remitoLeido.nro,
        })
      } else {
        result = await AlquileresModel.crear({
          id_cliente: clienteIdClean, id_administrativo: req.session.user.id,
          domicilio_entrega, domicilio_calle: calle, domicilio_numero: numero,
          zona_entrega, plazo_alquiler, precio_alquiler,
          id_contenedor: id_contenedor || null, metodo_pago: metodoPago,
          observaciones, obra,
          fecha_entrega_planificada: fechaInicio || null,
          id_chofer: id_chofer || null, id_camion: id_camion || null,
          nro_remito: remitoLeido.nro,
        })
      }
      await require('../models/facturacion.model').marcarAlCrear(result.id, req.body.paraFacturar, parseFloat(precio_alquiler) || 0)
      ubicarEnSegundoPlano(result.id)

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
      const clienteAlq = await ClientesModel.obtener(alquiler.id_cliente)
      // Último contenedor abierto de un grupo con cobro por alquiler: su cierre cobra todo
      // el grupo, así que se muestran los montos de cierre de cada contenedor.
      let cierresGrupo = null
      const g = alquiler.grupo
      if (g?.cobro_modo === 'alquiler' && !g.ops.some(o => o.abierta && o.id !== alquiler.id)) {
        cierresGrupo = []
        for (const o of g.ops.filter(o => o.estado !== 'anulado' && !o.cobrada)) {
          const c = await AlquileresModel.datosCierre(o.id)
          cierresGrupo.push({ id: o.id, numero_contenedor: o.numero_contenedor, precioActual: c ? c.precioActual : 0 })
        }
      }
      res.render('pages/alquileres/detalle', {
        titulo: `Alquiler OP-${String(alquiler.nro_op).padStart(4,'0')}`,
        alquiler, disponibles, recursos, choferesDisp, solapamiento,
        facturacion: await require('../models/facturacion.model').estadoOp(alquiler.id),
        camionesDisp: await OperacionesModel.camionesDisponibles('contenedores'),
        recursosEditable: alquiler.estado !== 'anulado',
        diasAmpliacion: plazoPorCuentaCorriente(!!clienteAlq?.cuenta_corriente),
        saldoFavorCliente: Math.max(0, Number(clienteAlq?.saldo) || 0),
        cierre: alquiler.detalle ? await AlquileresModel.datosCierre(alquiler.id) : null,
        cierresGrupo,
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
      const { fechaInicio, fechaFin, calle, obra } = req.body
      // Destino: se exige dirección (calle) u obra, al menos uno — igual que al crear.
      if (!(calle || '').trim() && !(obra || '').trim()) {
        req.flash('error', 'Cargá la dirección (calle) o la obra. Al menos uno es obligatorio.')
        return res.redirect(`/alquileres/contenedores/${req.params.id}/editar`)
      }
      // Sin el check y sin fecha de fin no hay forma de saber el plazo: queda sin fin.
      const sinFechaFin = req.body.sin_fecha_fin === '1' || req.body.sin_fecha_fin === 'on'
      let plazo_alquiler = null
      if (!sinFechaFin && fechaInicio && fechaFin) {
        plazo_alquiler = Math.max(1, diasHabilesEntre(fechaInicio, fechaFin) || 0)
      }
      // Sin cuenta corriente el plazo es SIEMPRE el estándar: no se puede editar a un valor
      // mayor, sea cual sea la fecha de fin cargada acá.
      if (plazo_alquiler != null) {
        const actual = await AlquileresModel.obtener(req.params.id)
        const cliente = actual?.id_cliente ? await ClientesModel.obtener(actual.id_cliente) : null
        if (!cliente?.cuenta_corriente) plazo_alquiler = PLAZO_ESTANDAR
      }
      const { direccionCambio } = await AlquileresModel.actualizar(req.params.id, {
        ...req.body,
        plazo_alquiler,
        fecha_entrega_planificada: fechaInicio || req.body.fecha_entrega_planificada || null,
      })
      if (direccionCambio) ubicarEnSegundoPlano(req.params.id)
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

  // La entrega solo arranca el período: el cobro se genera al retirar el contenedor.
  async entregar(req, res) {
    try {
      await AlquileresModel.entregar(req.params.id)
      req.flash('success', 'Entrega confirmada. Comenzó el período de alquiler.')
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

  // Repone el contenedor de un alquiler en curso por una unidad nueva disponible,
  // elegida automáticamente. La operación sigue igual, solo cambia qué contenedor la cubre.
  async reponer(req, res) {
    try {
      const r = await AlquileresModel.reponerContenedor(req.params.id)
      req.flash('success', `Contenedor N° ${r.numeroAnterior} repuesto por el N° ${r.numeroNuevo}.`)
    } catch (err) {
      console.error(err)
      req.flash('error', err.message || 'Error al reponer el contenedor.')
    }
    res.redirect(`/alquileres/contenedores/${req.params.id}`)
  },

  // Amplía el alquiler por el mismo plazo que le corresponde al cliente
  // (15 días con cuenta corriente, 4 sin ella). Se puede repetir.
  async ampliar(req, res) {
    try {
      const alquiler = await AlquileresModel.obtener(req.params.id)
      if (!alquiler) throw new Error('Alquiler no encontrado.')
      const cliente = await ClientesModel.obtener(alquiler.id_cliente)
      const dias = plazoPorCuentaCorriente(!!cliente?.cuenta_corriente)
      await AlquileresModel.ampliarPlazo(req.params.id, dias)
      req.flash('success', `Alquiler ampliado ${dias} días.`)
    } catch (err) {
      console.error(err)
      req.flash('error', err.message || 'Error al ampliar el alquiler.')
    }
    res.redirect(`/alquileres/contenedores/${req.params.id}`)
  },

  async devolverAPlanta(req, res) {
    try {
      const alquiler = await AlquileresModel.obtener(req.params.id)
      // Alquiler agrupado con cobro por alquiler: solo el retiro del último contenedor cobra.
      const grupoAlq = alquiler?.grupo?.cobro_modo === 'alquiler' ? alquiler.grupo : null
      const faltanOtros = grupoAlq ? grupoAlq.ops.filter(o => o.abierta && o.id !== alquiler.id).length : 0
      // "A convenir una vez finalizado": al cobrar hay que resolverlo sí o sí — un método de
      // pago real, o el check de "pendiente de pago" (queda en Cobranzas).
      const pendientePago = req.body.pendiente_pago === '1' || req.body.pendiente_pago === 'on'
      const metodoPagoFinal = (req.body.metodo_pago_final || '').trim() || null
      if (alquiler?.metodo_pago === 'a_convenir' && faltanOtros === 0 && !pendientePago && !metodoPagoFinal) {
        req.flash('error', 'Este alquiler quedó "a convenir": indicá un método de pago o marcá "Pendiente de pago".')
        return res.redirect(`/alquileres/contenedores/${req.params.id}`)
      }
      await AlquileresModel.devolverAPlanta(req.params.id)
      // El alquiler termina acá: es el momento en que se cobra (salvo que haya quedado
      // explícitamente pendiente de pago, o que en un grupo falten contenedores).
      const monto = pendientePago ? null
        : await AlquileresModel.cobrarAlCerrar(req.params.id, leerMontosPorOp(req.body.precio_final), metodoPagoFinal)
      if (alquiler?.detalle?.alquiler_siguiente_id) {
        await AlquileresModel.activarProgramado(alquiler.detalle.alquiler_siguiente_id)
      }
      const cantGrupo = grupoAlq ? grupoAlq.ops.filter(o => o.estado !== 'anulado').length : 0
      req.flash('success', faltanOtros > 0
        ? `Contenedor retirado. El alquiler se cobra todo junto al retirar el último contenedor (falta${faltanOtros === 1 ? '' : 'n'} ${faltanOtros}).`
        : monto != null
          ? `Contenedor retirado — alquiler cerrado por $${Math.round(monto).toLocaleString('es-AR')}${grupoAlq ? ` (${cantGrupo} contenedores)` : ''}.`
          : pendientePago
            ? 'Contenedor retirado — pago pendiente, quedó en Cobranzas.'
            : 'Contenedor retirado — ciclo completado.')
    } catch (err) {
      console.error(err)
      req.flash('error', err.message || 'Error al registrar devolución.')
    }
    res.redirect(`/alquileres/contenedores/${req.params.id}`)
  },

  async anular(req, res) {
    try {
      await AlquileresModel.anular(req.params.id)
      // Si era el último contenedor pendiente de un alquiler agrupado con cobro por
      // alquiler y los demás ya se retiraron, el cobro del grupo se genera ahora.
      const grupo = await AlquileresModel.grupoConCobroPorAlquiler(req.params.id)
      const monto = grupo ? await AlquileresModel.cobrarGrupo(grupo.id) : null
      req.flash('success', monto != null
        ? `Alquiler anulado. Se cobró el resto del alquiler agrupado por $${Math.round(monto).toLocaleString('es-AR')}.`
        : 'Alquiler anulado.')
    } catch (err) {
      console.error(err)
      req.flash('error', 'Error al anular.')
    }
    res.redirect('/alquileres/contenedores')
  },

  // ── Mapa de contenedores ──────────────────────────────────────────────────────
  // La vista y su JSON solo leen las coordenadas guardadas: abrir el mapa no
  // geocodifica nada. Los choferes lo ven en modo lectura.
  async mapa(req, res) {
    res.render('pages/alquileres/mapa', {
      titulo: 'Mapa de Contenedores',
      puedeEditar: req.session.user?.rol !== 'chofer',
      scripts: ['/js/mapaContenedores.js'],
    })
  },

  async mapaData(req, res) {
    try {
      await AlquileresModel.autoVencerAlquileres().catch(e => console.error('autoVencer:', e.message))
      const filas = await AlquileresModel.datosMapa()
      const items = filas.map(f => {
        const dir = textoDestino({ domicilio: f.domicilio_entrega, calle: f.domicilio_calle, numero: f.domicilio_numero })
        return {
          id: f.id,
          nro_op: f.nro_op,
          cliente: f.cliente_nombre || '',
          direccion: dir ? `${dir}, Córdoba` : '',
          obra: f.obra || '',
          zona: f.zona_entrega || '',
          numero_contenedor: f.numero_contenedor,
          fecha_inicio: f.fecha_inicio,
          estado: estadoMapa(f),
          dias_restantes: f.dias_restantes,
          geo_estado: f.geo_estado,
          geo_detalle: f.geo_detalle || '',
          // Ubicada por el centro del barrio o de la calle, no por la altura exacta
          aproximada: f.geo_estado === 'calle' || f.geo_estado === 'barrio',
          lat: f.lat,
          lng: f.lng,
        }
      })
      res.json({
        ubicados:  items.filter(i => i.lat != null && i.lng != null),
        sinUbicar: items.filter(i => i.lat == null || i.lng == null),
        puedeEditar: req.session.user?.rol !== 'chofer',
      })
    } catch (err) {
      console.error(err)
      res.status(500).json({ error: 'Error al cargar los datos del mapa.' })
    }
  },

  // Corrección manual: el usuario marca en el mapa dónde está el contenedor.
  async guardarUbicacionManual(req, res) {
    try {
      const lat = parseFloat(req.body.lat), lng = parseFloat(req.body.lng)
      if (!coordenadaValida(lat, lng)) return res.status(400).json({ error: 'Ubicación inválida.' })
      const alquiler = await AlquileresModel.obtener(req.params.id)
      if (!alquiler) return res.status(404).json({ error: 'Alquiler no encontrado.' })
      await AlquileresModel.guardarUbicacion(alquiler.id, { lat, lng, estado: 'manual' })
      res.json({ ok: true })
    } catch (err) {
      console.error(err)
      res.status(500).json({ error: 'Error al guardar la ubicación.' })
    }
  },

  // ── Cobranzas: alquileres "a convenir" ya retirados y sin cobrar ──────────────
  async cobranzas(req, res) {
    try {
      const pendientes = await AlquileresModel.pendientesDeCobro()
      // Monto estimado con la tarifa vigente (misma cuenta que se usaría al cerrar el
      // cobro), para que se vea de un vistazo cuánto habría que cobrar en cada caso.
      for (const p of pendientes) {
        // En una fila de grupo, el estimado de cada contenedor y el total
        for (const o of (p.esGrupo ? p.ops : [p])) {
          const cierre = await AlquileresModel.datosCierre(o.id)
          o.montoEstimado = cierre ? cierre.precioActual : (o.precio_alquiler || 0)
        }
        if (p.esGrupo) p.montoEstimado = p.ops.reduce((suma, o) => suma + o.montoEstimado, 0)
      }
      res.render('pages/alquileres/cobranzas', { titulo: 'Cobranzas de Contenedores', pendientes })
    } catch (err) {
      console.error(err); req.flash('error', 'Error al cargar las cobranzas.'); res.redirect('/alquileres/contenedores')
    }
  },

  // Resuelve un "a convenir" pendiente: cobra con el método elegido ahora.
  async resolverCobranza(req, res) {
    const back = '/alquileres/contenedores/cobranzas'
    try {
      const { metodo_pago_final, precio_final } = req.body
      if (!metodo_pago_final) {
        req.flash('error', 'Elegí un método de pago para cerrar el cobro.')
        return res.redirect(back)
      }
      if (metodo_pago_final === 'saldo_a_favor') {
        const alquiler = await AlquileresModel.obtener(req.params.id)
        const errSaldo = await ClientesModel.errorSaldoFavor(alquiler?.id_cliente)
        if (errSaldo) { req.flash('error', errSaldo); return res.redirect(back) }
      }
      const monto = await AlquileresModel.cobrarAlCerrar(req.params.id, leerMontosPorOp(precio_final), metodo_pago_final)
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

module.exports = AlquileresController
