'use strict'
const { query } = require('../config/db')
const VentasModel = require('../models/ventas.model')
const AlquileresModel = require('../models/alquileres.model')
const TransaccionesModel = require('../models/transacciones.model')
const ClientesModel = require('../models/clientes.model')
const RemitosModel = require('../models/remitos.model')
const FlotaModel = require('../models/flota.model')
const { generarRemitoPDFBuffer } = require('../utils/pdfRemito')
const { nombreArchivo } = require('../middlewares/upload')
const storage = require('../config/storage')

// Empleado vinculado al usuario logueado
async function empleadoDe(userId) {
  return (await query(`SELECT id, nombre, apellido FROM empleados WHERE id_usuario = ? AND activo = 1`, [userId])).rows[0]
}

// Último estado de movimiento de un contenedor
async function estadoCont(id_contenedor) {
  if (!id_contenedor) return null
  return (await query(`SELECT estado_paso FROM movimiento_contenedor WHERE id_contenedor = ? ORDER BY fecha_movimiento DESC, id DESC LIMIT 1`, [id_contenedor])).rows[0]?.estado_paso || null
}

// Fecha de inicio del alquiler (primer movimiento 'en_alquiler') de un contenedor en una OP
async function fechaEntrega(id_contenedor, id_oc) {
  const m = (await query(`SELECT fecha_movimiento FROM movimiento_contenedor WHERE id_contenedor = ? AND id_op_contenedor = ? AND estado_paso = 'en_alquiler' ORDER BY fecha_movimiento ASC LIMIT 1`, [id_contenedor, id_oc])).rows[0]
  return m ? String(m.fecha_movimiento).slice(0, 10) : null
}

function diasRestantes(finISO) {
  if (!finISO) return null
  const fin = new Date(finISO + 'T00:00:00')
  const hoy = new Date(); hoy.setHours(0, 0, 0, 0)
  return Math.round((fin - hoy) / 86400000)
}

// ¿El chofer tiene una tarea en curso? (entrega despachada o retiro en vuelta_a_planta)
async function tieneEnCurso(empId) {
  const desp = (await query(`SELECT 1 FROM op_encabezado WHERE id_chofer = ? AND estado = 'despachado' LIMIT 1`, [empId])).rows[0]
  if (desp) return true
  const ret = (await query(`
    SELECT 1 FROM op_encabezado op JOIN op_detalle_contenedor oc ON oc.id_orden_pedido = op.id
    WHERE op.id_chofer = ? AND op.tipo_op = 'C' AND op.estado = 'entregado'
      AND (SELECT estado_paso FROM movimiento_contenedor WHERE id_contenedor = oc.id_contenedor ORDER BY fecha_movimiento DESC, id DESC LIMIT 1) = 'vuelta_a_planta'
    LIMIT 1`, [empId])).rows[0]
  return !!ret
}

// Helper: ¿la fecha es posterior a hoy? (compara solo la parte YYYY-MM-DD)
function esFutura(fechaISO) {
  if (!fechaISO) return false
  const f = String(fechaISO).slice(0, 10)
  const hoy = new Date().toISOString().slice(0, 10)
  return f > hoy
}

// Construye la lista de tareas del día del chofer
async function construirTareas(empId) {
  const tareas = []

  // ── Viajes (venta con flete) ──────────────────────────────────
  const viajes = (await query(`
    SELECT op.id, op.nro_op, op.estado, op.fecha_entrega_planificada, op.observaciones,
           op.domicilio_calle, op.domicilio_altura,
           COALESCE(c.nombre,'Particular') AS cliente, c.tel_whatsapp,
           v.nombre AS camion, v.patente
    FROM op_encabezado op
    LEFT JOIN clientes c ON c.id = op.id_cliente
    LEFT JOIN flota_vehiculos v ON v.id = op.id_camion
    WHERE op.id_chofer = ? AND op.tipo_op = 'M' AND op.modalidad = 'flete' AND op.estado IN ('pendiente','despachado')
  `, [empId])).rows
  viajes.forEach(o => {
    const enCurso = o.estado === 'despachado'
    // Si está en curso (despachado), siempre va a HOY, sin importar la fecha planificada
    const programado = !enCurso && esFutura(o.fecha_entrega_planificada)
    tareas.push({
      id: o.id, tipo: 'viaje', icono: '🚚', titulo: 'Entrega de viaje',
      cliente: o.cliente, tel: o.tel_whatsapp,
      domicilio: [o.domicilio_calle, o.domicilio_altura].filter(Boolean).join(' ').trim(),
      camion: [o.camion, o.patente].filter(Boolean).join(' · '),
      nro_op: o.nro_op, fecha: o.fecha_entrega_planificada, observaciones: o.observaciones,
      fase: enCurso ? 'en_curso' : 'por_iniciar',
      programado,
      accionIniciar: 'Iniciar viaje', accionFinalizar: 'Confirmar entrega',
      detalleFase: enCurso ? 'En camino' : (programado ? 'Programado' : 'Por salir'),
    })
  })

  // ── Contenedores (entrega y retiro) ───────────────────────────
  const contenedores = (await query(`
    SELECT op.id, op.nro_op, op.estado, op.fecha_entrega_planificada,
           oc.id AS id_oc, oc.id_contenedor, oc.domicilio_entrega, oc.plazo_alquiler,
           cont.numero_contenedor, COALESCE(c.nombre,'Particular') AS cliente, c.tel_whatsapp,
           v.nombre AS camion, v.patente
    FROM op_encabezado op
    JOIN op_detalle_contenedor oc ON oc.id_orden_pedido = op.id
    LEFT JOIN contenedores cont ON cont.id = oc.id_contenedor
    LEFT JOIN clientes c ON c.id = op.id_cliente
    LEFT JOIN flota_vehiculos v ON v.id = op.id_camion
    WHERE op.id_chofer = ? AND op.tipo_op = 'C' AND op.estado IN ('pendiente','despachado','entregado')
  `, [empId])).rows

  for (const o of contenedores) {
    const base = {
      id: o.id, cliente: o.cliente, tel: o.tel_whatsapp,
      domicilio: o.domicilio_entrega || '', camion: [o.camion, o.patente].filter(Boolean).join(' · '),
      nro_op: o.nro_op, contenedor: o.numero_contenedor, sinContenedor: !o.id_contenedor,
      fecha: o.fecha_entrega_planificada,
    }
    const programadoFuturo = esFutura(o.fecha_entrega_planificada)
    if (o.estado === 'pendiente') {
      tareas.push({ ...base, tipo: 'contenedor_entrega', icono: '📦', titulo: 'Entrega de contenedor',
        fase: 'por_iniciar', programado: programadoFuturo,
        detalleFase: programadoFuturo ? 'Programado' : 'Por salir',
        accionIniciar: 'Iniciar entrega', accionFinalizar: 'Confirmar entrega' })
    } else if (o.estado === 'despachado') {
      tareas.push({ ...base, tipo: 'contenedor_entrega', icono: '📦', titulo: 'Entrega de contenedor',
        fase: 'en_curso', detalleFase: 'En camino', accionIniciar: 'Iniciar entrega', accionFinalizar: 'Confirmar entrega' })
    } else if (o.estado === 'entregado') {
      const ec = await estadoCont(o.id_contenedor)
      // El chofer NO ve los contenedores en alquiler activo (en_domicilio): no hay
      // nada que hacer hasta que la oficina marque "pendiente retiro".
      const fe = await fechaEntrega(o.id_contenedor, o.id_oc)
      const fin = (() => { if (!fe) return null; const d = new Date(fe + 'T00:00:00'); d.setDate(d.getDate() + (o.plazo_alquiler || 0)); return d.toISOString().slice(0, 10) })()
      const dr = diasRestantes(fin)
      if (ec === 'vuelta_a_planta') {
        tareas.push({ ...base, tipo: 'contenedor_retiro', icono: '⚠️', titulo: 'Retiro de contenedor',
          fase: 'en_curso', detalleFase: 'Volviendo a planta', fin, diasRestantes: dr, accionIniciar: 'Iniciar retiro', accionFinalizar: 'Devolver a planta' })
      } else if (ec === 'pendiente_retiro') {
        tareas.push({ ...base, tipo: 'contenedor_retiro', icono: '⚠️', titulo: 'Retiro de contenedor',
          fase: 'por_iniciar', detalleFase: 'Pendiente retiro', fin, diasRestantes: dr, accionIniciar: 'Iniciar retiro', accionFinalizar: 'Devolver a planta' })
      }
      // ec === 'en_alquiler' → sin tarea para el chofer
    }
  }

  const hayEnCurso = tareas.some(t => t.fase === 'en_curso')
  tareas.forEach(t => { t.bloqueada = hayEnCurso && t.fase === 'por_iniciar' && !t.programado })
  // Orden: en_curso → por_iniciar → en_servicio
  const peso = { en_curso: 0, por_iniciar: 1, en_servicio: 2 }
  tareas.sort((a, b) => peso[a.fase] - peso[b.fase])

  // Separar en HOY (incluye en_curso y en_servicio) vs PRÓXIMOS (programados a futuro)
  const hoy      = tareas.filter(t => !t.programado)
  const proximos = tareas.filter(t =>  t.programado).sort((a, b) => String(a.fecha || '').localeCompare(String(b.fecha || '')))

  return { tareas, hoy, proximos, hayEnCurso }
}

const HojaRutaController = {

  async index(req, res) {
    try {
      const empleado = await empleadoDe(req.session.user.id)
      const data = empleado
        ? await construirTareas(empleado.id)
        : { tareas: [], hoy: [], proximos: [], hayEnCurso: false }
      res.render('pages/hoja_ruta', {
        titulo: 'Hoja de Ruta', empleado,
        tareas: data.tareas, // compat
        hoy: data.hoy, proximos: data.proximos,
        hayEnCurso: data.hayEnCurso,
      })
    } catch (err) { console.error(err); req.flash('error', 'Error al cargar la hoja de ruta.'); res.redirect('/') }
  },

  // Reprogramar una tarea futura para hoy
  async realizarHoy(req, res) {
    const back = '/hoja-de-ruta'
    try {
      const v = await HojaRutaController._validar(req)
      if (!v) { req.flash('error', 'Tarea no válida o no asignada a vos.'); return res.redirect(back) }
      const { op } = v
      if (op.estado !== 'pendiente') {
        req.flash('error', 'Solo se pueden reprogramar tareas pendientes.')
        return res.redirect(back)
      }
      await query(
        `UPDATE op_encabezado SET fecha_entrega_planificada = to_char(CURRENT_DATE, 'YYYY-MM-DD') WHERE id = ?`,
        [op.id]
      )
      req.flash('success', 'Tarea reprogramada para hoy. Ya podés iniciarla.')
    } catch (err) { console.error(err); req.flash('error', err.message || 'Error al reprogramar.') }
    res.redirect(back)
  },

  // Verifica que la OP pertenezca al chofer logueado; devuelve {emp, op} o null
  async _validar(req) {
    const emp = await empleadoDe(req.session.user.id)
    if (!emp) return null
    const op = (await query(`SELECT id, tipo_op, modalidad, estado, id_chofer, id_cliente FROM op_encabezado WHERE id = ?`, [req.params.id])).rows[0]
    if (!op || Number(op.id_chofer) !== Number(emp.id)) return null
    return { emp, op }
  },

  async iniciar(req, res) {
    const back = '/hoja-de-ruta'
    try {
      const v = await HojaRutaController._validar(req)
      if (!v) { req.flash('error', 'Tarea no válida o no asignada a vos.'); return res.redirect(back) }
      if (await tieneEnCurso(v.emp.id)) { req.flash('error', 'Ya tenés una tarea en curso. Finalizala antes de iniciar otra.'); return res.redirect(back) }
      const { op } = v
      if (op.tipo_op === 'M' && op.modalidad === 'flete' && op.estado === 'pendiente') {
        await VentasModel.despachar(op.id)
      } else if (op.tipo_op === 'C' && op.estado === 'pendiente') {
        const oc = (await query(`SELECT id_contenedor FROM op_detalle_contenedor WHERE id_orden_pedido = ? LIMIT 1`, [op.id])).rows[0]
        if (!oc?.id_contenedor) { req.flash('error', 'El contenedor aún no está asignado. Avisá a la oficina.'); return res.redirect(back) }
        await AlquileresModel.despachar(op.id)
      } else if (op.tipo_op === 'C' && op.estado === 'entregado') {
        const oc = (await query(`SELECT id_contenedor FROM op_detalle_contenedor WHERE id_orden_pedido = ? LIMIT 1`, [op.id])).rows[0]
        if (await estadoCont(oc?.id_contenedor) !== 'pendiente_retiro') {
          req.flash('error', 'Este contenedor todavía no está marcado como pendiente de retiro.')
          return res.redirect(back)
        }
        await AlquileresModel.iniciarRetiro(op.id)
      } else {
        req.flash('error', 'Esta tarea no se puede iniciar en su estado actual.')
        return res.redirect(back)
      }
      // Redirigir a vista de viaje en curso con mapa
      res.redirect(`/hoja-de-ruta/${op.id}/viaje-en-curso`)
    } catch (err) { console.error(err); req.flash('error', err.message || 'Error al iniciar la tarea.'); res.redirect(back) }
  },

  async verEnCurso(req, res) {
    try {
      const v = await HojaRutaController._validar(req)
      if (!v) { req.flash('error', 'Tarea no válida o no asignada a vos.'); return res.redirect('/hoja-de-ruta') }
      const { op, emp } = v

      // Datos de la operación (encabezado + cliente + camión)
      const opData = (await query(`
        SELECT op.id, op.nro_op, op.estado, op.tipo_op, op.domicilio_calle, op.domicilio_altura,
               op.domicilio_lat, op.domicilio_lng, op.observaciones,
               c.nombre AS cliente, c.tel_whatsapp,
               v.nombre AS camion, v.patente
        FROM op_encabezado op
        LEFT JOIN clientes c ON c.id = op.id_cliente
        LEFT JOIN flota_vehiculos v ON v.id = op.id_camion
        WHERE op.id = ?
      `, [op.id])).rows[0]

      if (!opData) { req.flash('error', 'Operación no encontrada.'); return res.redirect('/hoja-de-ruta') }

      // Resolver el domicilio del destino según el tipo de operación
      let domicilio = [opData.domicilio_calle, opData.domicilio_altura].filter(Boolean).join(' ').trim()
      // Fase: entrega (llevar el contenedor) o retiro (traerlo de vuelta).
      let fase = 'entrega'
      let proximo = null
      if (opData.tipo_op === 'C') {
        const oc = (await query(`SELECT domicilio_entrega, zona_entrega FROM op_detalle_contenedor WHERE id_orden_pedido = ? LIMIT 1`, [op.id])).rows[0]
        if (oc?.domicilio_entrega) domicilio = oc.domicilio_entrega
        if (opData.estado === 'entregado') {
          fase = 'retiro'
          proximo = await AlquileresModel.proximoAlquiler(op.id)
        }
      }

      // Geocodificar el destino en el backend si aún no tiene coordenadas.
      // Así la vista SIEMPRE recibe el destino resuelto y la ruta se dibuja.
      let lat = opData.domicilio_lat
      let lng = opData.domicilio_lng
      if ((lat == null || lng == null) && domicilio) {
        const geo = await HojaRutaController._geocodificar(domicilio)
        if (geo) {
          lat = geo.lat; lng = geo.lng
          await query(`UPDATE op_encabezado SET domicilio_lat = ?, domicilio_lng = ? WHERE id = ?`, [lat, lng, op.id])
        }
      }

      res.render('pages/viaje_en_curso', {
        titulo: 'Viaje en curso',
        empleado: emp,
        op: {
          id: opData.id,
          nro_op: opData.nro_op,
          estado: opData.estado,
          tipo_op: opData.tipo_op,
          fase,
          proximo, // { id, nro_op, cliente_nombre, domicilio_entrega } | null
          cliente: opData.cliente || 'Particular',
          tel: opData.tel_whatsapp,
          domicilio: domicilio || '',
          domicilio_lat: lat,
          domicilio_lng: lng,
          observaciones: opData.observaciones,
          camion: [opData.camion, opData.patente].filter(Boolean).join(' · ')
        }
      })
    } catch (err) { console.error(err); req.flash('error', 'Error al cargar la vista del viaje.'); res.redirect('/hoja-de-ruta') }
  },

  // Geocodifica una dirección a {lat, lng} usando Nominatim (OpenStreetMap).
  // Se ejecuta en el backend para respetar las políticas de uso (User-Agent)
  // y cachear el resultado en la base de datos.
  async _geocodificar(texto) {
    if (!texto) return null
    try {
      const q = encodeURIComponent(texto + ', Córdoba, Argentina')
      const url = `https://nominatim.openstreetmap.org/search?q=${q}&format=json&limit=1`
      const resp = await fetch(url, { headers: { 'User-Agent': 'SuelosurGestion/1.0 (sistema interno de logistica)' } })
      if (!resp.ok) return null
      const data = await resp.json()
      if (Array.isArray(data) && data[0]?.lat && data[0]?.lon) {
        return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) }
      }
    } catch (e) { console.error('Geocodificación falló:', e.message) }
    return null
  },

  async guardarUbicacion(req, res) {
    try {
      const v = await HojaRutaController._validar(req)
      if (!v) { return res.status(403).json({ error: 'No autorizado' }) }

      const { lat, lng, accuracy } = req.body
      if (lat == null || lng == null) {
        return res.status(400).json({ error: 'Coordenadas requeridas' })
      }

      const { emp, op } = v
      await query(`
        INSERT INTO rastreo_chofer (id_op, id_empleado, lat, lng, exactitud, fecha_registro)
        VALUES (?, ?, ?, ?, ?, to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
      `, [op.id, emp.id, lat, lng, accuracy || null])

      res.json({ ok: true })
    } catch (err) {
      console.error(err)
      res.status(500).json({ error: err.message })
    }
  },

  // Tracking global: el chofer logueado reporta su posición desde cualquier
  // página. Si tiene un viaje en curso (despachado), se asocia esa OP.
  async registrarPosicion(req, res) {
    try {
      const emp = await empleadoDe(req.session.user.id)
      if (!emp) { return res.status(204).end() } // No es chofer vinculado: ignorar silenciosamente

      const { lat, lng, accuracy, velocidad } = req.body
      if (lat == null || lng == null) {
        return res.status(400).json({ error: 'Coordenadas requeridas' })
      }

      // Buscar OP en curso del chofer para asociarla (si existe)
      const opActiva = (await query(`
        SELECT id FROM op_encabezado WHERE id_chofer = ? AND estado = 'despachado' ORDER BY created_at DESC LIMIT 1
      `, [emp.id])).rows[0]

      await query(`
        INSERT INTO rastreo_chofer (id_op, id_empleado, lat, lng, velocidad, exactitud, fecha_registro)
        VALUES (?, ?, ?, ?, ?, ?, to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
      `, [opActiva?.id || null, emp.id, lat, lng, velocidad || 0, accuracy || null])

      res.json({ ok: true })
    } catch (err) {
      console.error(err)
      res.status(500).json({ error: err.message })
    }
  },

  async geocodificarDestino(req, res) {
    try {
      const v = await HojaRutaController._validar(req)
      if (!v) { return res.status(403).json({ error: 'No autorizado' }) }

      const { lat, lng } = req.body
      if (lat == null || lng == null) {
        return res.status(400).json({ error: 'Coordenadas requeridas' })
      }

      const { op } = v
      await query(`
        UPDATE op_encabezado SET domicilio_lat = ?, domicilio_lng = ? WHERE id = ?
      `, [lat, lng, op.id])

      res.json({ ok: true })
    } catch (err) {
      console.error(err)
      res.status(500).json({ error: err.message })
    }
  },

  async obtenerUbicacionActual(req, res) {
    try {
      const emp = await empleadoDe(req.session.user.id)
      if (!emp) { return res.status(403).json({ error: 'Usuario no vinculado a empleado' }) }

      const ubicacion = (await query(`
        SELECT lat, lng, fecha_registro FROM rastreo_chofer
        WHERE id_empleado = ?
        ORDER BY fecha_registro DESC
        LIMIT 1
      `, [emp.id])).rows[0]

      if (!ubicacion) {
        return res.json({ lat: null, lng: null, fecha: null })
      }

      res.json({
        lat: ubicacion.lat,
        lng: ubicacion.lng,
        fecha: ubicacion.fecha_registro
      })
    } catch (err) {
      console.error(err)
      res.status(500).json({ error: err.message })
    }
  },

  async finalizar(req, res) {
    const back = '/hoja-de-ruta'
    try {
      const v = await HojaRutaController._validar(req)
      if (!v) { req.flash('error', 'Tarea no válida o no asignada a vos.'); return res.redirect(back) }
      const { op } = v

      // Fase de la tarea: entrega (llevar) o retiro de contenedor (traer).
      const esEntrega = (op.tipo_op === 'M' && op.modalidad === 'flete' && op.estado === 'despachado')
                     || (op.tipo_op === 'C' && op.estado === 'despachado')
      const esRetiroContenedor = op.tipo_op === 'C' && op.estado === 'entregado'

      // Tanto la entrega como el retiro necesitan la firma del cliente (cada uno
      // genera su propio remito: remito de entrega y remito de retiro).
      if ((esEntrega || esRetiroContenedor) && !req.body.firma_cliente) {
        req.flash('error', `Falta la firma del cliente para confirmar ${esRetiroContenedor ? 'el retiro' : 'la entrega'}.`)
        return res.redirect(back)
      }
      // Guardar la firma EN LA BASE DE DATOS (no en disco). Render tiene filesystem
      // efímero: un archivo se borraría al reiniciar. Cada fase guarda su firma aparte.
      if (req.body.firma_cliente) {
        const firma = HojaRutaController._normalizarFirma(req.body.firma_cliente)
        if (firma) {
          const acl = (req.body.firma_aclaracion || '').trim() || null
          if (esRetiroContenedor) {
            await query(`UPDATE op_encabezado SET firma_retiro = ?, firma_retiro_aclaracion = ? WHERE id = ?`, [firma, acl, op.id])
          } else {
            await query(`UPDATE op_encabezado SET firma_cliente = ?, firma_aclaracion = ? WHERE id = ?`, [firma, acl, op.id])
          }
        }
      }
      // Guardar la foto del remito si el chofer adjuntó una (opcional), separada por fase.
      if (req.file) {
        const filename = nombreArchivo(esRetiroContenedor ? 'remito-retiro' : 'remito', op.id, req.file.originalname)
        await storage.guardar(req.file.buffer, filename, req.file.mimetype)
        if (esRetiroContenedor) {
          await query(`UPDATE op_encabezado SET archivo_remito_retiro = ? WHERE id = ?`, [filename, op.id])
        } else {
          await query(`UPDATE op_encabezado SET archivo_remito = ? WHERE id = ?`, [filename, op.id])
        }
      }

      if (op.tipo_op === 'M' && op.modalidad === 'flete' && op.estado === 'despachado') {
        const full = await VentasModel.obtener(op.id)
        await VentasModel.entregar(op.id)
        // Kilometraje automático del camión (ida + vuelta) según la ruta navegada
        if (full.id_camion && req.body.distancia_km) {
          await FlotaModel.sumarKilometraje(full.id_camion, req.body.distancia_km, op.id)
            .catch(e => console.error('Kilometraje automático:', e.message))
        }
        await TransaccionesModel.crear({
          tipo: 'Venta Viaje', id_op_encabezado: op.id, nro_remito: full.nro_remito,
          cliente_id: full.id_cliente, cliente: full.cliente_nombre, monto: full.total,
          descripcion: full.observaciones || 'Venta con viaje', metodo_pago: full.metodo_pago || 'efectivo',
        })
        if (full.metodo_pago === 'cuenta_corriente' && full.id_cliente) {
          await ClientesModel.agregarMovimiento(full.id_cliente, { tipo: 'deuda', descripcion: `Venta Viaje OP-${String(full.nro_op).padStart(4,'0')}`, monto: -(full.total || 0) })
        }
        req.flash('success', 'Entrega confirmada. ¡Tarea completada!')
      } else if (op.tipo_op === 'C' && op.estado === 'despachado') {
        const al = await AlquileresModel.obtener(op.id)
        await AlquileresModel.entregar(op.id)
        const monto = al.detalle?.precio_alquiler || 0
        await TransaccionesModel.crear({
          tipo: 'Alquiler', id_op_encabezado: op.id, nro_remito: al.nro_remito,
          cliente_id: al.id_cliente, cliente: al.cliente_nombre, monto,
          descripcion: `Alquiler contenedor #${al.detalle?.numero_contenedor || '?'}`, metodo_pago: al.metodo_pago || 'efectivo',
        })
        if (al.metodo_pago === 'cuenta_corriente' && al.id_cliente) {
          await ClientesModel.agregarMovimiento(al.id_cliente, { tipo: 'deuda', descripcion: `Alquiler contenedor #${al.detalle?.numero_contenedor || '?'}`, monto: -monto })
        }
        req.flash('success', 'Contenedor entregado. Comenzó el período de alquiler.')
      } else if (esRetiroContenedor) {
        const oc = (await query(`SELECT id_contenedor, alquiler_siguiente_id FROM op_detalle_contenedor WHERE id_orden_pedido = ? LIMIT 1`, [op.id])).rows[0]
        if (await estadoCont(oc?.id_contenedor) !== 'vuelta_a_planta') {
          req.flash('error', 'Primero tenés que iniciar el retiro.'); return res.redirect(back)
        }
        const quiereProximo = req.body.destino_retiro === 'proximo' && oc?.alquiler_siguiente_id
        if (quiereProximo) {
          const idB = await AlquileresModel.iniciarProximoAlquiler(op.id)
          req.flash('success', 'Contenedor retirado. En camino al próximo alquiler.')
          return res.redirect(`/hoja-de-ruta/${idB}/viaje-en-curso`)
        }
        const al = await AlquileresModel.obtener(op.id)
        await AlquileresModel.devolverAPlanta(op.id)
        if (al?.detalle?.alquiler_siguiente_id) {
          await AlquileresModel.activarProgramado(al.detalle.alquiler_siguiente_id)
        }
        req.flash('success', 'Contenedor retirado y devuelto a planta. ¡Tarea completada!')
      } else {
        req.flash('error', 'Esta tarea no se puede finalizar en su estado actual.')
      }

      // Archivar el remito de ENTREGA firmado como PDF en Storage (comprobante
      // inmutable). Es secundario: si falla, no rompe la operación. El remito de
      // retiro se regenera on-demand, no se archiva (evita pisar el de entrega).
      if (req.body.firma_cliente && !esRetiroContenedor) {
        try {
          const remito = await RemitosModel.obtener(op.id)
          if (remito) {
            const buffer = await generarRemitoPDFBuffer(remito)
            const filename = `remito-firmado-${op.id}.pdf`
            await storage.guardar(buffer, filename, 'application/pdf')
            await query(`UPDATE op_encabezado SET archivo_remito_pdf = ? WHERE id = ?`, [filename, op.id])
          }
        } catch (e) { console.error('No se pudo archivar el PDF del remito:', e.message) }
      }
    } catch (err) { console.error(err); req.flash('error', err.message || 'Error al finalizar la tarea.') }
    res.redirect(back)
  },

  // Valida la firma (dataURL PNG en base64) y la devuelve tal cual para
  // guardarla en la base de datos. Persistir en BD (y no en disco) hace que
  // la firma sobreviva a los reinicios del servidor.
  _normalizarFirma(dataUrl) {
    const s = String(dataUrl || '').trim()
    const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(s)
    if (!m) return null
    const bytes = Buffer.from(m[1], 'base64')
    if (!bytes.length || bytes.length > 2 * 1024 * 1024) return null // máx 2MB
    return s
  },

  // Servir la foto del remito (imagen/pdf) desde el almacenamiento
  async verRemitoFirmado(req, res) {
    try {
      const r = (await query(`SELECT archivo_remito FROM op_encabezado WHERE id = ?`, [req.params.id])).rows[0]
      if (!r || !r.archivo_remito) { req.flash('error', 'No hay foto del remito adjunta.'); return res.redirect('back') }
      const buf = await storage.leer(r.archivo_remito)
      if (!buf) { req.flash('error', 'Archivo no encontrado.'); return res.redirect('back') }
      const ext = (r.archivo_remito.split('.').pop() || '').toLowerCase()
      res.set('Content-Type', ext === 'pdf' ? 'application/pdf' : ext === 'png' ? 'image/png' : 'image/jpeg')
      res.send(buf)
    } catch (err) { console.error(err); res.redirect('back') }
  },
}

module.exports = HojaRutaController
