'use strict'
const path = require('path')
const fs   = require('fs')
const FlotaModel = require('../models/flota.model')
const CombustibleModel = require('../models/combustible.model')
const MantenimientoModel = require('../models/mantenimiento.model')
const GastosModel = require('../models/gastos_vehiculo.model')
const DocumentosModel = require('../models/documentos.model')
const AlertasModel = require('../models/alertas.model')
const EmpleadosModel = require('../models/empleados.model')
const AsignacionesModel = require('../models/asignaciones.model')
const { registrarAuditoria, historial } = require('../utils/auditoria')
const { resolverPeriodo, etiquetaPeriodo } = require('../utils/periodos')
const { DIR_DOCUMENTOS } = require('../middlewares/upload')
const { generarTablaPDF } = require('../utils/pdfTabla')
const { generarExcel } = require('../utils/excel')

const ENTIDAD = 'vehiculo'
const uid = (req) => req.session.user?.id
const serveDoc = (res, archivo) => {
  if (!archivo) return res.redirect('back')
  const f = path.join(DIR_DOCUMENTOS, archivo)
  if (!fs.existsSync(f)) return res.redirect('back')
  res.sendFile(f)
}

const FlotaController = {

  index(req, res) {
    try {
      const { q, estado, tipo, marca, chofer } = req.query
      const vehiculos = FlotaModel.listar({ q, estado, tipo, marca, chofer })
      const opciones = FlotaModel.opcionesFiltro()
      res.render('pages/flota/index', {
        titulo: 'Flota Camiones', vehiculos, estados: FlotaModel.ESTADOS,
        resumen: FlotaModel.resumenFlota(), opciones,
        choferes: EmpleadosModel.listarChoferes({ soloActivos: true }),
        filtros: { q: q || '', estado: estado || '', tipo: tipo || '', marca: marca || '', chofer: chofer || '' },
      })
    } catch (err) { console.error(err); req.flash('error', 'Error al cargar la flota.'); res.redirect('/') }
  },

  disponibilidad(req, res) {
    try {
      const camiones = FlotaModel.disponibilidad()
      const maquinas = require('../models/maquinaria.model').disponibilidad()
      const cuenta = (arr, s) => arr.filter(x => x.situacion === s).length
      res.render('pages/flota/disponibilidad', {
        titulo: 'Disponibilidad de Flota', camiones, maquinas,
        resumen: {
          camDisp: cuenta(camiones, 'disponible'), camAsig: cuenta(camiones, 'asignado'), camMant: cuenta(camiones, 'mantenimiento'),
          maqDisp: cuenta(maquinas, 'disponible'), maqAsig: cuenta(maquinas, 'asignado'), maqMant: cuenta(maquinas, 'mantenimiento'),
        },
      })
    } catch (err) { console.error(err); req.flash('error', 'Error al cargar disponibilidad.'); res.redirect('/flota') }
  },

  nuevo(req, res) {
    res.render('pages/flota/form', { titulo: 'Nuevo Camión', vehiculo: null, estados: FlotaModel.ESTADOS })
  },

  crear(req, res) {
    try {
      if (!req.body.nombre && !req.body.patente) { req.flash('error', 'Nombre o patente requeridos.'); return res.redirect('/flota/nuevo') }
      const id = FlotaModel.crear(req.body)
      registrarAuditoria({ entidad_tipo: ENTIDAD, entidad_id: id, accion: 'crear', usuario: uid(req), detalle: { patente: req.body.patente } })
      req.flash('success', 'Camión registrado.')
      res.redirect(`/flota/${id}`)
    } catch (err) { console.error(err); req.flash('error', err.message || 'Error al registrar.'); res.redirect('/flota/nuevo') }
  },

  detalle(req, res) {
    try {
      const vehiculo = FlotaModel.obtener(req.params.id)
      if (!vehiculo) { req.flash('error', 'Camión no encontrado.'); return res.redirect('/flota') }
      const tab = req.query.tab || 'datos'
      const periodo = resolverPeriodo({ preset: req.query.preset, desde: req.query.fechaDesde, hasta: req.query.fechaHasta, mes: req.query.mes })
      res.render('pages/flota/detalle', {
        titulo: vehiculo.nombre || vehiculo.patente, vehiculo, tab, estados: FlotaModel.ESTADOS,
        documentos: DocumentosModel.listar(ENTIDAD, vehiculo.id),
        combustible: CombustibleModel.listar(vehiculo.id, { desde: periodo.desde, hasta: periodo.hasta }),
        resumenComb: CombustibleModel.resumen(vehiculo.id, { desde: periodo.desde, hasta: periodo.hasta }),
        mantenimientos: MantenimientoModel.listar(vehiculo.id, { desde: periodo.desde, hasta: periodo.hasta }),
        resumenMant: MantenimientoModel.resumen(vehiculo.id, { desde: periodo.desde, hasta: periodo.hasta }),
        reglas: MantenimientoModel.reglas(vehiculo.id),
        gastos: GastosModel.listar(vehiculo.id, { desde: periodo.desde, hasta: periodo.hasta }),
        resumenGastos: GastosModel.resumen(vehiculo.id, { desde: periodo.desde, hasta: periodo.hasta }),
        choferes: EmpleadosModel.listarChoferes({ soloActivos: true }),
        historialEstados: FlotaModel.historialEstados(vehiculo.id),
        asignacionesRecurso: AsignacionesModel.historialRecurso('camion', vehiculo.id),
        auditoria: historial(ENTIDAD, vehiculo.id),
        alertas: AlertasModel.listar({ modulo: 'flota' }).filter(a => a.entidad_id === vehiculo.id),
        periodoLabel: etiquetaPeriodo(periodo),
        filtros: { ...req.query, fechaDesde: periodo.desde || '', fechaHasta: periodo.hasta || '', preset: periodo.preset || '' },
      })
    } catch (err) { console.error(err); req.flash('error', 'Error al cargar el camión.'); res.redirect('/flota') }
  },

  editar(req, res) {
    const vehiculo = FlotaModel.obtener(req.params.id)
    if (!vehiculo) { req.flash('error', 'No encontrado.'); return res.redirect('/flota') }
    res.render('pages/flota/form', { titulo: 'Editar Camión', vehiculo, estados: FlotaModel.ESTADOS })
  },

  actualizar(req, res) {
    try {
      FlotaModel.actualizar(req.params.id, req.body)
      registrarAuditoria({ entidad_tipo: ENTIDAD, entidad_id: req.params.id, accion: 'modificar', usuario: uid(req) })
      req.flash('success', 'Camión actualizado.')
      res.redirect(`/flota/${req.params.id}`)
    } catch (err) { console.error(err); req.flash('error', err.message || 'Error.'); res.redirect(`/flota/${req.params.id}/editar`) }
  },

  cambiarEstado(req, res) {
    try {
      FlotaModel.cambiarEstado(req.params.id, req.body.estado, uid(req), req.body.observaciones)
      registrarAuditoria({ entidad_tipo: ENTIDAD, entidad_id: req.params.id, accion: 'modificar', usuario: uid(req), detalle: { estado: req.body.estado } })
      req.flash('success', 'Estado actualizado.')
    } catch (err) { console.error(err); req.flash('error', err.message || 'Error.') }
    res.redirect(`/flota/${req.params.id}`)
  },

  toggleActivo(req, res) {
    try { FlotaModel.toggleActivo(req.params.id); req.flash('success', 'Estado de alta/baja actualizado.') }
    catch (err) { console.error(err); req.flash('error', 'Error.') }
    res.redirect(`/flota/${req.params.id}`)
  },

  // ── Documentos ────────────────────────────────────────────────
  subirDocumento(req, res) {
    const back = `/flota/${req.params.id}?tab=documentos`
    try {
      if (!req.body.tipo) { req.flash('error', 'Indicá el tipo.'); return res.redirect(back) }
      DocumentosModel.crear({ entidad_tipo: ENTIDAD, entidad_id: req.params.id, tipo: req.body.tipo,
        descripcion: req.body.descripcion, archivo: req.file ? req.file.filename : null,
        fecha_emision: req.body.fecha_emision, fecha_vencimiento: req.body.fecha_vencimiento })
      req.flash('success', 'Documento agregado.')
    } catch (err) { console.error(err); req.flash('error', err.message || 'Error.') }
    res.redirect(back)
  },
  verDocumento(req, res) { const d = DocumentosModel.obtener(req.params.docId); serveDoc(res, d && d.archivo) },
  eliminarDocumento(req, res) {
    try { const a = DocumentosModel.eliminar(req.params.docId); if (a) { const f = path.join(DIR_DOCUMENTOS, a); if (fs.existsSync(f)) fs.unlinkSync(f) } } catch (err) { console.error(err) }
    res.redirect(`/flota/${req.params.id}?tab=documentos`)
  },

  // ── Combustible ───────────────────────────────────────────────
  cargarCombustible(req, res) {
    const back = `/flota/${req.params.id}?tab=combustible`
    try { CombustibleModel.crear({ id_vehiculo: req.params.id, ...req.body }); req.flash('success', 'Carga registrada.') }
    catch (err) { console.error(err); req.flash('error', 'Error.') }
    res.redirect(back)
  },
  eliminarCombustible(req, res) {
    try { CombustibleModel.eliminar(req.params.cargaId) } catch (err) { console.error(err) }
    res.redirect(`/flota/${req.params.id}?tab=combustible`)
  },

  // ── Mantenimiento ─────────────────────────────────────────────
  cargarMantenimiento(req, res) {
    const back = `/flota/${req.params.id}?tab=mantenimiento`
    try { MantenimientoModel.crear({ id_vehiculo: req.params.id, archivo: req.file ? req.file.filename : null, ...req.body }); req.flash('success', 'Mantenimiento registrado.') }
    catch (err) { console.error(err); req.flash('error', 'Error.') }
    res.redirect(back)
  },
  verFacturaMant(req, res) { const m = MantenimientoModel.obtener(req.params.mid); serveDoc(res, m && m.archivo) },
  eliminarMantenimiento(req, res) {
    try { const a = MantenimientoModel.eliminar(req.params.mid); if (a) { const f = path.join(DIR_DOCUMENTOS, a); if (fs.existsSync(f)) fs.unlinkSync(f) } } catch (err) { console.error(err) }
    res.redirect(`/flota/${req.params.id}?tab=mantenimiento`)
  },
  crearRegla(req, res) {
    try { MantenimientoModel.crearRegla({ id_vehiculo: req.params.id, ...req.body }); req.flash('success', 'Regla creada.') }
    catch (err) { console.error(err); req.flash('error', 'Error.') }
    res.redirect(`/flota/${req.params.id}?tab=mantenimiento`)
  },
  eliminarRegla(req, res) {
    try { MantenimientoModel.eliminarRegla(req.params.reglaId) } catch (err) { console.error(err) }
    res.redirect(`/flota/${req.params.id}?tab=mantenimiento`)
  },

  // ── Gastos ────────────────────────────────────────────────────
  cargarGasto(req, res) {
    const back = `/flota/${req.params.id}?tab=gastos`
    try {
      if (!req.body.categoria) { req.flash('error', 'Indicá la categoría.'); return res.redirect(back) }
      GastosModel.crear({ id_vehiculo: req.params.id, archivo: req.file ? req.file.filename : null, ...req.body })
      req.flash('success', 'Gasto registrado.')
    } catch (err) { console.error(err); req.flash('error', 'Error.') }
    res.redirect(back)
  },
  verComprobanteGasto(req, res) { const g = GastosModel.obtener(req.params.gid); serveDoc(res, g && g.archivo) },
  eliminarGasto(req, res) {
    try { const a = GastosModel.eliminar(req.params.gid); if (a) { const f = path.join(DIR_DOCUMENTOS, a); if (fs.existsSync(f)) fs.unlinkSync(f) } } catch (err) { console.error(err) }
    res.redirect(`/flota/${req.params.id}?tab=gastos`)
  },

  // ── Reportes ──────────────────────────────────────────────────
  reporte(req, res) {
    try {
      const tipo = req.params.tipo  // disponibilidad | combustible | mantenimiento | gastos | kilometraje
      const formato = req.query.formato || 'pdf'
      const periodo = resolverPeriodo({ preset: req.query.preset, desde: req.query.fechaDesde, hasta: req.query.fechaHasta })
      const vehiculos = FlotaModel.listar({})
      let titulo = '', columnas = [], filas = []

      if (tipo === 'disponibilidad' || tipo === 'kilometraje') {
        titulo = tipo === 'kilometraje' ? 'Kilometraje de flota' : 'Disponibilidad de flota'
        columnas = [
          { header: 'Vehículo', key: 'v', width: 0.3 }, { header: 'Patente', key: 'pat' },
          { header: 'Estado', key: 'est' }, { header: 'Kilometraje', key: 'km', align: 'right' },
        ]
        filas = vehiculos.map(v => ({ v: v.nombre || '—', pat: v.patente || '—', est: v.estado_operativo, km: (v.kilometraje || 0).toLocaleString('es-AR') }))
      } else if (tipo === 'combustible') {
        titulo = 'Consumo de combustible'
        columnas = [
          { header: 'Vehículo', key: 'v', width: 0.28 }, { header: 'Cargas', key: 'c', align: 'right' },
          { header: 'Litros', key: 'l', align: 'right' }, { header: 'Costo', key: 'costo', align: 'right', money: true },
          { header: 'Rend. (km/l)', key: 'rend', align: 'right' }, { header: 'Costo/km', key: 'ckm', align: 'right', money: true },
        ]
        filas = vehiculos.map(v => { const r = CombustibleModel.resumen(v.id, { desde: periodo.desde, hasta: periodo.hasta })
          return { v: v.nombre || v.patente, c: r.cargas, l: r.litros, costo: r.costo, rend: r.rendimiento, ckm: r.costoPorKm } })
      } else if (tipo === 'mantenimiento') {
        titulo = 'Mantenimientos y services'
        columnas = [
          { header: 'Vehículo', key: 'v', width: 0.3 }, { header: 'Services', key: 'n', align: 'right' },
          { header: 'Preventivos', key: 'p', align: 'right' }, { header: 'Correctivos', key: 'c', align: 'right' },
          { header: 'Costo total', key: 'costo', align: 'right', money: true },
        ]
        filas = vehiculos.map(v => { const r = MantenimientoModel.resumen(v.id, { desde: periodo.desde, hasta: periodo.hasta })
          return { v: v.nombre || v.patente, n: r.n, p: r.preventivos, c: r.correctivos, costo: r.costo } })
      } else { // gastos
        titulo = 'Gastos por vehículo'
        columnas = [{ header: 'Vehículo', key: 'v', width: 0.5 }, { header: 'Gastos totales', key: 'total', align: 'right', money: true }]
        filas = vehiculos.map(v => ({ v: v.nombre || v.patente, total: GastosModel.resumen(v.id, { desde: periodo.desde, hasta: periodo.hasta }).total }))
      }

      const nombreArchivo = `flota-${tipo}`
      if (formato === 'excel') return generarExcel(res, { titulo, columnas, filas, nombreArchivo })
      return generarTablaPDF(res, { titulo, subtitulo: etiquetaPeriodo(periodo), columnas, filas, nombreArchivo })
    } catch (err) { console.error(err); req.flash('error', 'Error al generar el reporte.'); res.redirect('/flota') }
  },
}

module.exports = FlotaController
