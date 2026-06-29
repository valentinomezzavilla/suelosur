'use strict'
const path = require('path')
const fs   = require('fs')
const { query } = require('../config/db')
const EmpleadosModel  = require('../models/empleados.model')
const DocumentosModel = require('../models/documentos.model')
const AsignacionesModel = require('../models/asignaciones.model')
const ControlHorarioModel = require('../models/control_horario.model')
const PagosModel = require('../models/pagos_empleado.model')
const AlertasModel = require('../models/alertas.model')
const { registrarAuditoria, historial } = require('../utils/auditoria')
const { resolverPeriodo, etiquetaPeriodo } = require('../utils/periodos')
const { DIR_DOCUMENTOS } = require('../middlewares/upload')
const { generarTablaPDF } = require('../utils/pdfTabla')
const { generarExcel } = require('../utils/excel')

const ENTIDAD = 'empleado'
const uid = (req) => req.session.user?.id

const ChoferesController = {

  async index(req, res) {
    try {
      const { q } = req.query
      const choferes = await EmpleadosModel.listarChoferes({ q })
      res.render('pages/choferes/index', { titulo: 'Choferes', choferes, filtros: { q: q || '' } })
    } catch (err) { console.error(err); req.flash('error', 'Error al cargar choferes.'); res.redirect('/') }
  },

  async dashboard(req, res) {
    try {
      const choferes = await EmpleadosModel.listarChoferes({})
      const activos  = choferes.filter(c => c.activo).length
      const sinCamion = choferes.filter(c => c.activo && !c.camion_principal).length
      const alertas = await AlertasModel.listar({ modulo: 'choferes' })
      const licenciasPorVencer = alertas.filter(a => a.tipo === 'licencia').length
      const docsVencidos = alertas.filter(a => a.tipo === 'documento' && a.severidad === 'vencido').length
      // HE del mes (todas las jornadas de choferes en el mes actual)
      const periodo = resolverPeriodo({ preset: 'mes' })
      let heMes = 0
      for (const c of choferes) {
        const r = await ControlHorarioModel.resumen(c.id, { desde: periodo.desde, hasta: periodo.hasta })
        heMes += r.extra
      }
      res.render('pages/choferes/dashboard', {
        titulo: 'Choferes', metricas: { activos, total: choferes.length, sinCamion, licenciasPorVencer, docsVencidos, heMes },
        alertas: alertas.slice(0, 12),
      })
    } catch (err) { console.error(err); req.flash('error', 'Error al cargar el dashboard.'); res.redirect('/choferes') }
  },

  async nuevo(req, res) {
    res.render('pages/choferes/form', { titulo: 'Nuevo Chofer', chofer: null, supervisores: await EmpleadosModel.supervisores() })
  },

  async crear(req, res) {
    try {
      if (!req.body.nombre) { req.flash('error', 'El nombre es obligatorio.'); return res.redirect('/choferes/nuevo') }
      req.body.es_chofer = 'true'
      const id = await EmpleadosModel.crear(req.body)
      registrarAuditoria({ entidad_tipo: ENTIDAD, entidad_id: id, accion: 'crear', usuario: uid(req), detalle: { nombre: req.body.nombre } })
      req.flash('success', 'Chofer creado.')
      res.redirect(`/choferes/${id}`)
    } catch (err) { console.error(err); req.flash('error', 'Error al crear el chofer.'); res.redirect('/choferes/nuevo') }
  },

  async detalle(req, res) {
    try {
      const chofer = await EmpleadosModel.obtener(req.params.id)
      if (!chofer) { req.flash('error', 'Chofer no encontrado.'); return res.redirect('/choferes') }
      const tab = req.query.tab || 'datos'
      const periodo = resolverPeriodo({ preset: req.query.preset, desde: req.query.fechaDesde, hasta: req.query.fechaHasta, mes: req.query.mes })

      res.render('pages/choferes/detalle', {
        titulo: `${chofer.nombre} ${chofer.apellido || ''}`.trim(),
        chofer, tab,
        supervisores: await EmpleadosModel.supervisores(chofer.id),
        documentos: await DocumentosModel.listar(ENTIDAD, chofer.id),
        asignacionesActivas: await AsignacionesModel.activas(chofer.id),
        asignacionesHist: await AsignacionesModel.historialEmpleado(chofer.id),
        camionesDisp: await AsignacionesModel.camionesDisponibles(),
        maquinasDisp: await AsignacionesModel.maquinasDisponibles(),
        jornadas: await ControlHorarioModel.listar(chofer.id, { desde: periodo.desde, hasta: periodo.hasta }),
        resumenHoras: await ControlHorarioModel.resumen(chofer.id, { desde: periodo.desde, hasta: periodo.hasta }),
        pagos: await PagosModel.listar(chofer.id, { desde: periodo.desde, hasta: periodo.hasta }),
        resumenPagos: await PagosModel.resumen(chofer.id, { desde: periodo.desde, hasta: periodo.hasta }),
        auditoria: await historial(ENTIDAD, chofer.id),
        periodoLabel: etiquetaPeriodo(periodo),
        filtros: { ...req.query, fechaDesde: periodo.desde || '', fechaHasta: periodo.hasta || '', preset: periodo.preset || '' },
      })
    } catch (err) { console.error(err); req.flash('error', 'Error al cargar el chofer.'); res.redirect('/choferes') }
  },

  async editar(req, res) {
    const chofer = await EmpleadosModel.obtener(req.params.id)
    if (!chofer) { req.flash('error', 'No encontrado.'); return res.redirect('/choferes') }
    res.render('pages/choferes/form', { titulo: 'Editar Chofer', chofer, supervisores: await EmpleadosModel.supervisores(chofer.id) })
  },

  async actualizar(req, res) {
    try {
      if (!req.body.nombre) { req.flash('error', 'El nombre es obligatorio.'); return res.redirect(`/choferes/${req.params.id}/editar`) }
      req.body.es_chofer = 'true'
      await EmpleadosModel.actualizar(req.params.id, req.body)
      registrarAuditoria({ entidad_tipo: ENTIDAD, entidad_id: req.params.id, accion: 'modificar', usuario: uid(req) })
      req.flash('success', 'Chofer actualizado.')
      res.redirect(`/choferes/${req.params.id}`)
    } catch (err) { console.error(err); req.flash('error', 'Error al actualizar.'); res.redirect(`/choferes/${req.params.id}/editar`) }
  },

  async darBaja(req, res) {
    try {
      await EmpleadosModel.darBaja(req.params.id, req.body.motivo)
      await AsignacionesModel.liberarEmpleado(req.params.id)
      registrarAuditoria({ entidad_tipo: ENTIDAD, entidad_id: req.params.id, accion: 'baja', usuario: uid(req), detalle: { motivo: req.body.motivo } })
      req.flash('success', 'Chofer dado de baja. Se liberaron sus asignaciones.')
    } catch (err) { console.error(err); req.flash('error', 'Error.') }
    res.redirect(`/choferes/${req.params.id}`)
  },

  async reingresar(req, res) {
    try {
      await EmpleadosModel.reingresar(req.params.id)
      registrarAuditoria({ entidad_tipo: ENTIDAD, entidad_id: req.params.id, accion: 'reingreso', usuario: uid(req) })
      req.flash('success', 'Chofer reingresado.')
    } catch (err) { console.error(err); req.flash('error', 'Error.') }
    res.redirect(`/choferes/${req.params.id}`)
  },

  // ── Documentos ────────────────────────────────────────────────
  async subirDocumento(req, res) {
    const back = `/choferes/${req.params.id}?tab=documentos`
    try {
      const { tipo, descripcion, fecha_emision, fecha_vencimiento } = req.body
      if (!tipo) { req.flash('error', 'Indicá el tipo de documento.'); return res.redirect(back) }
      await DocumentosModel.crear({
        entidad_tipo: ENTIDAD, entidad_id: req.params.id, tipo, descripcion,
        archivo: req.file ? req.file.filename : null, fecha_emision, fecha_vencimiento,
      })
      registrarAuditoria({ entidad_tipo: ENTIDAD, entidad_id: req.params.id, accion: 'modificar', usuario: uid(req), detalle: { documento: tipo } })
      req.flash('success', 'Documento agregado.')
    } catch (err) { console.error(err); req.flash('error', err.message || 'Error al subir el documento.') }
    res.redirect(back)
  },

  async verDocumento(req, res) {
    try {
      const doc = await DocumentosModel.obtener(req.params.docId)
      if (!doc || !doc.archivo) { req.flash('error', 'Sin archivo.'); return res.redirect('back') }
      const file = path.join(DIR_DOCUMENTOS, doc.archivo)
      if (!fs.existsSync(file)) { req.flash('error', 'Archivo no encontrado.'); return res.redirect('back') }
      res.sendFile(file)
    } catch (err) { console.error(err); res.redirect('back') }
  },

  async eliminarDocumento(req, res) {
    try {
      const archivo = await DocumentosModel.eliminar(req.params.docId)
      if (archivo) { const f = path.join(DIR_DOCUMENTOS, archivo); if (fs.existsSync(f)) { try { fs.unlinkSync(f) } catch (_) {} } }
      req.flash('success', 'Documento eliminado.')
    } catch (err) { console.error(err); req.flash('error', 'Error.') }
    res.redirect(`/choferes/${req.params.id}?tab=documentos`)
  },

  // ── Asignaciones de recursos (camión / máquina) ───────────────
  async asignarRecurso(req, res) {
    const back = `/choferes/${req.params.id}?tab=asignaciones`
    try {
      const { recurso_tipo, recurso_id, observaciones } = req.body
      await AsignacionesModel.asignar({ id_empleado: req.params.id, recurso_tipo, recurso_id, observaciones })
      registrarAuditoria({ entidad_tipo: ENTIDAD, entidad_id: req.params.id, accion: 'modificar', usuario: uid(req), detalle: { asignacion: recurso_tipo } })
      req.flash('success', `${recurso_tipo === 'maquina' ? 'Máquina' : 'Camión'} asignado.`)
    } catch (err) { console.error(err); req.flash('error', err.message || 'Error al asignar.') }
    res.redirect(back)
  },

  async finalizarAsignacion(req, res) {
    try { await AsignacionesModel.finalizar(req.params.asigId); req.flash('success', 'Asignación finalizada.') }
    catch (err) { console.error(err); req.flash('error', 'Error.') }
    res.redirect(`/choferes/${req.params.id}?tab=asignaciones`)
  },

  // ── Control horario ───────────────────────────────────────────
  async cargarJornada(req, res) {
    const back = `/choferes/${req.params.id}?tab=horario`
    try {
      await ControlHorarioModel.crear({ id_empleado: req.params.id, ...req.body })
      req.flash('success', 'Jornada registrada.')
    } catch (err) { console.error(err); req.flash('error', 'Error.') }
    res.redirect(back)
  },

  async aprobarJornada(req, res) {
    try { await ControlHorarioModel.aprobar(req.params.jorId, uid(req)); req.flash('success', 'Horas extra aprobadas.') }
    catch (err) { console.error(err); req.flash('error', 'Error.') }
    res.redirect(`/choferes/${req.params.id}?tab=horario`)
  },

  async eliminarJornada(req, res) {
    try { await ControlHorarioModel.eliminar(req.params.jorId) } catch (err) { console.error(err) }
    res.redirect(`/choferes/${req.params.id}?tab=horario`)
  },

  // ── Pagos ─────────────────────────────────────────────────────
  async registrarPago(req, res) {
    const back = `/choferes/${req.params.id}?tab=pagos`
    try {
      const { tipo, monto } = req.body
      if (!tipo || !(parseFloat(monto) > 0)) { req.flash('error', 'Tipo y monto válidos requeridos.'); return res.redirect(back) }
      await PagosModel.crear({ id_empleado: req.params.id, ...req.body })
      registrarAuditoria({ entidad_tipo: ENTIDAD, entidad_id: req.params.id, accion: 'modificar', usuario: uid(req), detalle: { pago: tipo, monto } })
      req.flash('success', 'Pago registrado.')
    } catch (err) { console.error(err); req.flash('error', 'Error.') }
    res.redirect(back)
  },

  async eliminarPago(req, res) {
    try { await PagosModel.eliminar(req.params.pagoId) } catch (err) { console.error(err) }
    res.redirect(`/choferes/${req.params.id}?tab=pagos`)
  },

  // ── Reportes ──────────────────────────────────────────────────
  async reporte(req, res) {
    try {
      const tipo = req.params.tipo            // horas | pagos | licencias | documentacion
      const formato = req.query.formato || 'pdf'
      const periodo = resolverPeriodo({ preset: req.query.preset, desde: req.query.fechaDesde, hasta: req.query.fechaHasta })
      const choferes = await EmpleadosModel.listarChoferes({})
      let titulo = '', columnas = [], filas = []

      if (tipo === 'horas') {
        titulo = 'Horas trabajadas por chofer'
        columnas = [
          { header: 'Chofer', key: 'chofer', width: 0.35 },
          { header: 'Jornadas', key: 'jornadas', align: 'right' },
          { header: 'H. normales', key: 'normales', align: 'right' },
          { header: 'H. extra', key: 'extra', align: 'right' },
          { header: 'HE aprob.', key: 'aprob', align: 'right' },
        ]
        for (const c of choferes) {
          const r = await ControlHorarioModel.resumen(c.id, { desde: periodo.desde, hasta: periodo.hasta })
          filas.push({ chofer: `${c.nombre} ${c.apellido || ''}`.trim(), jornadas: r.jornadas, normales: r.normales, extra: r.extra, aprob: r.extra_aprobadas })
        }
      } else if (tipo === 'pagos') {
        titulo = 'Pagos por chofer'
        columnas = [
          { header: 'Chofer', key: 'chofer', width: 0.4 },
          { header: 'Movimientos', key: 'count', align: 'right' },
          { header: 'Neto', key: 'neto', align: 'right', money: true },
        ]
        for (const c of choferes) {
          const r = await PagosModel.resumen(c.id, { desde: periodo.desde, hasta: periodo.hasta })
          filas.push({ chofer: `${c.nombre} ${c.apellido || ''}`.trim(), count: r.count, neto: r.neto })
        }
      } else if (tipo === 'licencias') {
        titulo = 'Licencias de conducir'
        columnas = [
          { header: 'Chofer', key: 'chofer', width: 0.4 },
          { header: 'Categoría', key: 'cat' },
          { header: 'N°', key: 'num' },
          { header: 'Vencimiento', key: 'venc' },
        ]
        filas = choferes.map(c => ({
          chofer: `${c.nombre} ${c.apellido || ''}`.trim(),
          cat: c.licencia_categoria || '—', num: c.licencia_numero || '—',
          venc: c.licencia_vencimiento || '—',
        }))
      } else { // documentacion
        titulo = 'Documentación de choferes'
        columnas = [
          { header: 'Chofer', key: 'chofer', width: 0.3 },
          { header: 'Documento', key: 'doc' },
          { header: 'Emisión', key: 'emi' },
          { header: 'Vencimiento', key: 'venc' },
        ]
        for (const c of choferes) {
          const docs = await DocumentosModel.listar(ENTIDAD, c.id)
          docs.forEach(d => filas.push({
            chofer: `${c.nombre} ${c.apellido || ''}`.trim(), doc: d.tipo,
            emi: d.fecha_emision || '—', venc: d.fecha_vencimiento || '—',
          }))
        }
      }

      const nombreArchivo = `choferes-${tipo}`
      if (formato === 'excel') return generarExcel(res, { titulo, columnas, filas, nombreArchivo })
      return generarTablaPDF(res, { titulo, subtitulo: etiquetaPeriodo(periodo), columnas, filas, nombreArchivo })
    } catch (err) { console.error(err); req.flash('error', 'Error al generar el reporte.'); res.redirect('/choferes') }
  },

  // Resolver alerta de vencimiento de pago: registra el pago y adelanta el
  // vencimiento un mes (los pagos suelen ser mensuales).
  async resolverPagoVencimiento(req, res) {
    const back = req.get('Referer') || '/alertas'
    try {
      const emp = await EmpleadosModel.obtener(req.params.id)
      if (!emp) { req.flash('error', 'Empleado no encontrado.'); return res.redirect(back) }
      await PagosModel.crear({
        id_empleado: emp.id, tipo: 'sueldo',
        monto: emp.sueldo_basico || emp.salario || 0,
        fecha: new Date().toISOString().slice(0, 10),
        descripcion: 'Pago registrado al resolver alerta de vencimiento',
      })
      const base = emp.fecha_vencimiento_pago ? new Date(emp.fecha_vencimiento_pago + 'T00:00:00') : new Date()
      base.setMonth(base.getMonth() + 1)
      const proximo = base.toISOString().slice(0, 10)
      await query(`UPDATE empleados SET fecha_vencimiento_pago = ? WHERE id = ?`, [proximo, emp.id])
      req.flash('success', `Pago registrado. Próximo vencimiento: ${proximo}.`)
    } catch (err) { console.error(err); req.flash('error', err.message || 'Error al resolver el pago.') }
    res.redirect(back)
  },

  async obtenerUbicacionActual(req, res) {
    try {
      const empleadoId = req.params.id

      // Verificar que el empleado exista y sea chofer
      const empleado = (await query(`
        SELECT id FROM empleados WHERE id = ? AND es_chofer = 1
      `, [empleadoId])).rows[0]

      if (!empleado) {
        return res.status(404).json({ error: 'Chofer no encontrado' })
      }

      // Obtener última ubicación registrada
      const ubicacion = (await query(`
        SELECT lat, lng, fecha_registro FROM rastreo_chofer
        WHERE id_empleado = ?
        ORDER BY fecha_registro DESC
        LIMIT 1
      `, [empleadoId])).rows[0]

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
}

module.exports = ChoferesController
