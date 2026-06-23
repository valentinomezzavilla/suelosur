'use strict'
const path = require('path')
const fs   = require('fs')
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

  index(req, res) {
    try {
      const { q } = req.query
      const choferes = EmpleadosModel.listarChoferes({ q })
      res.render('pages/choferes/index', { titulo: 'Choferes', choferes, filtros: { q: q || '' } })
    } catch (err) { console.error(err); req.flash('error', 'Error al cargar choferes.'); res.redirect('/') }
  },

  dashboard(req, res) {
    try {
      const choferes = EmpleadosModel.listarChoferes({})
      const activos  = choferes.filter(c => c.activo).length
      const sinCamion = choferes.filter(c => c.activo && !c.camion_principal).length
      const alertas = AlertasModel.listar({ modulo: 'choferes' })
      const licenciasPorVencer = alertas.filter(a => a.tipo === 'licencia').length
      const docsVencidos = alertas.filter(a => a.tipo === 'documento' && a.severidad === 'vencido').length
      // HE del mes (todas las jornadas de choferes en el mes actual)
      const periodo = resolverPeriodo({ preset: 'mes' })
      let heMes = 0
      choferes.forEach(c => { heMes += ControlHorarioModel.resumen(c.id, { desde: periodo.desde, hasta: periodo.hasta }).extra })
      res.render('pages/choferes/dashboard', {
        titulo: 'Choferes', metricas: { activos, total: choferes.length, sinCamion, licenciasPorVencer, docsVencidos, heMes },
        alertas: alertas.slice(0, 12),
      })
    } catch (err) { console.error(err); req.flash('error', 'Error al cargar el dashboard.'); res.redirect('/choferes') }
  },

  nuevo(req, res) {
    res.render('pages/choferes/form', { titulo: 'Nuevo Chofer', chofer: null, supervisores: EmpleadosModel.supervisores() })
  },

  crear(req, res) {
    try {
      if (!req.body.nombre) { req.flash('error', 'El nombre es obligatorio.'); return res.redirect('/choferes/nuevo') }
      req.body.es_chofer = 'true'
      const id = EmpleadosModel.crear(req.body)
      registrarAuditoria({ entidad_tipo: ENTIDAD, entidad_id: id, accion: 'crear', usuario: uid(req), detalle: { nombre: req.body.nombre } })
      req.flash('success', 'Chofer creado.')
      res.redirect(`/choferes/${id}`)
    } catch (err) { console.error(err); req.flash('error', 'Error al crear el chofer.'); res.redirect('/choferes/nuevo') }
  },

  detalle(req, res) {
    try {
      const chofer = EmpleadosModel.obtener(req.params.id)
      if (!chofer) { req.flash('error', 'Chofer no encontrado.'); return res.redirect('/choferes') }
      const tab = req.query.tab || 'datos'
      const periodo = resolverPeriodo({ preset: req.query.preset, desde: req.query.fechaDesde, hasta: req.query.fechaHasta, mes: req.query.mes })

      res.render('pages/choferes/detalle', {
        titulo: `${chofer.nombre} ${chofer.apellido || ''}`.trim(),
        chofer, tab,
        supervisores: EmpleadosModel.supervisores(chofer.id),
        documentos: DocumentosModel.listar(ENTIDAD, chofer.id),
        asignacionesActivas: AsignacionesModel.activas(chofer.id),
        asignacionesHist: AsignacionesModel.historialEmpleado(chofer.id),
        camionesDisp: AsignacionesModel.camionesDisponibles(),
        maquinasDisp: AsignacionesModel.maquinasDisponibles(),
        jornadas: ControlHorarioModel.listar(chofer.id, { desde: periodo.desde, hasta: periodo.hasta }),
        resumenHoras: ControlHorarioModel.resumen(chofer.id, { desde: periodo.desde, hasta: periodo.hasta }),
        pagos: PagosModel.listar(chofer.id, { desde: periodo.desde, hasta: periodo.hasta }),
        resumenPagos: PagosModel.resumen(chofer.id, { desde: periodo.desde, hasta: periodo.hasta }),
        auditoria: historial(ENTIDAD, chofer.id),
        periodoLabel: etiquetaPeriodo(periodo),
        filtros: { ...req.query, fechaDesde: periodo.desde || '', fechaHasta: periodo.hasta || '', preset: periodo.preset || '' },
      })
    } catch (err) { console.error(err); req.flash('error', 'Error al cargar el chofer.'); res.redirect('/choferes') }
  },

  editar(req, res) {
    const chofer = EmpleadosModel.obtener(req.params.id)
    if (!chofer) { req.flash('error', 'No encontrado.'); return res.redirect('/choferes') }
    res.render('pages/choferes/form', { titulo: 'Editar Chofer', chofer, supervisores: EmpleadosModel.supervisores(chofer.id) })
  },

  actualizar(req, res) {
    try {
      if (!req.body.nombre) { req.flash('error', 'El nombre es obligatorio.'); return res.redirect(`/choferes/${req.params.id}/editar`) }
      req.body.es_chofer = 'true'
      EmpleadosModel.actualizar(req.params.id, req.body)
      registrarAuditoria({ entidad_tipo: ENTIDAD, entidad_id: req.params.id, accion: 'modificar', usuario: uid(req) })
      req.flash('success', 'Chofer actualizado.')
      res.redirect(`/choferes/${req.params.id}`)
    } catch (err) { console.error(err); req.flash('error', 'Error al actualizar.'); res.redirect(`/choferes/${req.params.id}/editar`) }
  },

  darBaja(req, res) {
    try {
      EmpleadosModel.darBaja(req.params.id, req.body.motivo)
      AsignacionesModel.liberarEmpleado(req.params.id)
      registrarAuditoria({ entidad_tipo: ENTIDAD, entidad_id: req.params.id, accion: 'baja', usuario: uid(req), detalle: { motivo: req.body.motivo } })
      req.flash('success', 'Chofer dado de baja. Se liberaron sus asignaciones.')
    } catch (err) { console.error(err); req.flash('error', 'Error.') }
    res.redirect(`/choferes/${req.params.id}`)
  },

  reingresar(req, res) {
    try {
      EmpleadosModel.reingresar(req.params.id)
      registrarAuditoria({ entidad_tipo: ENTIDAD, entidad_id: req.params.id, accion: 'reingreso', usuario: uid(req) })
      req.flash('success', 'Chofer reingresado.')
    } catch (err) { console.error(err); req.flash('error', 'Error.') }
    res.redirect(`/choferes/${req.params.id}`)
  },

  // ── Documentos ────────────────────────────────────────────────
  subirDocumento(req, res) {
    const back = `/choferes/${req.params.id}?tab=documentos`
    try {
      const { tipo, descripcion, fecha_emision, fecha_vencimiento } = req.body
      if (!tipo) { req.flash('error', 'Indicá el tipo de documento.'); return res.redirect(back) }
      DocumentosModel.crear({
        entidad_tipo: ENTIDAD, entidad_id: req.params.id, tipo, descripcion,
        archivo: req.file ? req.file.filename : null, fecha_emision, fecha_vencimiento,
      })
      registrarAuditoria({ entidad_tipo: ENTIDAD, entidad_id: req.params.id, accion: 'modificar', usuario: uid(req), detalle: { documento: tipo } })
      req.flash('success', 'Documento agregado.')
    } catch (err) { console.error(err); req.flash('error', err.message || 'Error al subir el documento.') }
    res.redirect(back)
  },

  verDocumento(req, res) {
    try {
      const doc = DocumentosModel.obtener(req.params.docId)
      if (!doc || !doc.archivo) { req.flash('error', 'Sin archivo.'); return res.redirect('back') }
      const file = path.join(DIR_DOCUMENTOS, doc.archivo)
      if (!fs.existsSync(file)) { req.flash('error', 'Archivo no encontrado.'); return res.redirect('back') }
      res.sendFile(file)
    } catch (err) { console.error(err); res.redirect('back') }
  },

  eliminarDocumento(req, res) {
    try {
      const archivo = DocumentosModel.eliminar(req.params.docId)
      if (archivo) { const f = path.join(DIR_DOCUMENTOS, archivo); if (fs.existsSync(f)) { try { fs.unlinkSync(f) } catch (_) {} } }
      req.flash('success', 'Documento eliminado.')
    } catch (err) { console.error(err); req.flash('error', 'Error.') }
    res.redirect(`/choferes/${req.params.id}?tab=documentos`)
  },

  // ── Asignaciones de recursos (camión / máquina) ───────────────
  asignarRecurso(req, res) {
    const back = `/choferes/${req.params.id}?tab=asignaciones`
    try {
      const { recurso_tipo, recurso_id, observaciones } = req.body
      AsignacionesModel.asignar({ id_empleado: req.params.id, recurso_tipo, recurso_id, observaciones })
      registrarAuditoria({ entidad_tipo: ENTIDAD, entidad_id: req.params.id, accion: 'modificar', usuario: uid(req), detalle: { asignacion: recurso_tipo } })
      req.flash('success', `${recurso_tipo === 'maquina' ? 'Máquina' : 'Camión'} asignado.`)
    } catch (err) { console.error(err); req.flash('error', err.message || 'Error al asignar.') }
    res.redirect(back)
  },

  finalizarAsignacion(req, res) {
    try { AsignacionesModel.finalizar(req.params.asigId); req.flash('success', 'Asignación finalizada.') }
    catch (err) { console.error(err); req.flash('error', 'Error.') }
    res.redirect(`/choferes/${req.params.id}?tab=asignaciones`)
  },

  // ── Control horario ───────────────────────────────────────────
  cargarJornada(req, res) {
    const back = `/choferes/${req.params.id}?tab=horario`
    try {
      ControlHorarioModel.crear({ id_empleado: req.params.id, ...req.body })
      req.flash('success', 'Jornada registrada.')
    } catch (err) { console.error(err); req.flash('error', 'Error.') }
    res.redirect(back)
  },

  aprobarJornada(req, res) {
    try { ControlHorarioModel.aprobar(req.params.jorId, uid(req)); req.flash('success', 'Horas extra aprobadas.') }
    catch (err) { console.error(err); req.flash('error', 'Error.') }
    res.redirect(`/choferes/${req.params.id}?tab=horario`)
  },

  eliminarJornada(req, res) {
    try { ControlHorarioModel.eliminar(req.params.jorId) } catch (err) { console.error(err) }
    res.redirect(`/choferes/${req.params.id}?tab=horario`)
  },

  // ── Pagos ─────────────────────────────────────────────────────
  registrarPago(req, res) {
    const back = `/choferes/${req.params.id}?tab=pagos`
    try {
      const { tipo, monto } = req.body
      if (!tipo || !(parseFloat(monto) > 0)) { req.flash('error', 'Tipo y monto válidos requeridos.'); return res.redirect(back) }
      PagosModel.crear({ id_empleado: req.params.id, ...req.body })
      registrarAuditoria({ entidad_tipo: ENTIDAD, entidad_id: req.params.id, accion: 'modificar', usuario: uid(req), detalle: { pago: tipo, monto } })
      req.flash('success', 'Pago registrado.')
    } catch (err) { console.error(err); req.flash('error', 'Error.') }
    res.redirect(back)
  },

  eliminarPago(req, res) {
    try { PagosModel.eliminar(req.params.pagoId) } catch (err) { console.error(err) }
    res.redirect(`/choferes/${req.params.id}?tab=pagos`)
  },

  // ── Reportes ──────────────────────────────────────────────────
  reporte(req, res) {
    try {
      const tipo = req.params.tipo            // horas | pagos | licencias | documentacion
      const formato = req.query.formato || 'pdf'
      const periodo = resolverPeriodo({ preset: req.query.preset, desde: req.query.fechaDesde, hasta: req.query.fechaHasta })
      const choferes = EmpleadosModel.listarChoferes({})
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
        filas = choferes.map(c => {
          const r = ControlHorarioModel.resumen(c.id, { desde: periodo.desde, hasta: periodo.hasta })
          return { chofer: `${c.nombre} ${c.apellido || ''}`.trim(), jornadas: r.jornadas, normales: r.normales, extra: r.extra, aprob: r.extra_aprobadas }
        })
      } else if (tipo === 'pagos') {
        titulo = 'Pagos por chofer'
        columnas = [
          { header: 'Chofer', key: 'chofer', width: 0.4 },
          { header: 'Movimientos', key: 'count', align: 'right' },
          { header: 'Neto', key: 'neto', align: 'right', money: true },
        ]
        filas = choferes.map(c => {
          const r = PagosModel.resumen(c.id, { desde: periodo.desde, hasta: periodo.hasta })
          return { chofer: `${c.nombre} ${c.apellido || ''}`.trim(), count: r.count, neto: r.neto }
        })
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
        choferes.forEach(c => {
          DocumentosModel.listar(ENTIDAD, c.id).forEach(d => filas.push({
            chofer: `${c.nombre} ${c.apellido || ''}`.trim(), doc: d.tipo,
            emi: d.fecha_emision || '—', venc: d.fecha_vencimiento || '—',
          }))
        })
      }

      const nombreArchivo = `choferes-${tipo}`
      if (formato === 'excel') return generarExcel(res, { titulo, columnas, filas, nombreArchivo })
      return generarTablaPDF(res, { titulo, subtitulo: etiquetaPeriodo(periodo), columnas, filas, nombreArchivo })
    } catch (err) { console.error(err); req.flash('error', 'Error al generar el reporte.'); res.redirect('/choferes') }
  },
}

module.exports = ChoferesController
