'use strict'
const EmpleadosModel = require('../models/empleados.model')
const AsignacionesModel = require('../models/asignaciones.model')
const paginar        = require('../utils/paginar')

// Deriva es_chofer del cargo seleccionado
const setEsChofer = (body) => { body.es_chofer = (body.cargo === 'Chofer') ? 'true' : '' }

const EmpleadosController = {

  index(req, res) {
    try {
      const { q, page } = req.query
      const todos = EmpleadosModel.buscar({ q })
      const { items: empleados, total, page: pag, limit, totalPaginas } = paginar(todos, page, 15)
      res.render('pages/empleados/index', {
        titulo: 'Flota de Personal', empleados, total, page: pag, limit, totalPaginas,
        filtros: { q: q || '' },
      })
    } catch (err) {
      console.error(err); req.flash('error', 'Error al cargar el personal.'); res.redirect('back')
    }
  },

  nuevo(req, res) {
    res.render('pages/empleados/form', {
      titulo: 'Nuevo Empleado', empleado: null,
      usuarios: EmpleadosModel.usuariosVinculables(),
    })
  },

  crear(req, res) {
    try {
      const { nombre, dni } = req.body
      if (!nombre || !nombre.trim()) { req.flash('error', 'El nombre es obligatorio.'); return res.redirect('/empleados/nuevo') }
      if (dni && EmpleadosModel.dniEnUso(dni)) { req.flash('error', `Ya existe un empleado con DNI ${dni}.`); return res.redirect('/empleados/nuevo') }
      setEsChofer(req.body)
      EmpleadosModel.crear(req.body)
      req.flash('success', `Empleado ${nombre} creado.`)
      res.redirect('/empleados')
    } catch (err) {
      console.error(err); req.flash('error', 'Error al crear el empleado.'); res.redirect('/empleados/nuevo')
    }
  },

  detalle(req, res) {
    try {
      const empleado = EmpleadosModel.obtener(req.params.id)
      if (!empleado) { req.flash('error', 'Empleado no encontrado.'); return res.redirect('/empleados') }
      res.render('pages/empleados/detalle', {
        titulo: `${empleado.nombre} ${empleado.apellido || ''}`.trim(), empleado,
        asignacionesActivas: AsignacionesModel.activas(empleado.id),
        asignacionesHist: AsignacionesModel.historialEmpleado(empleado.id),
        camionesDisp: AsignacionesModel.camionesDisponibles(),
        maquinasDisp: AsignacionesModel.maquinasDisponibles(),
      })
    } catch (err) {
      console.error(err); req.flash('error', 'Error.'); res.redirect('/empleados')
    }
  },

  editar(req, res) {
    try {
      const empleado = EmpleadosModel.obtener(req.params.id)
      if (!empleado) { req.flash('error', 'Empleado no encontrado.'); return res.redirect('/empleados') }
      res.render('pages/empleados/form', {
        titulo: 'Editar Empleado', empleado,
        usuarios: EmpleadosModel.usuariosVinculables(empleado.id),
      })
    } catch (err) {
      console.error(err); req.flash('error', 'Error.'); res.redirect('/empleados')
    }
  },

  actualizar(req, res) {
    try {
      const id = req.params.id
      const { nombre, dni } = req.body
      if (!nombre || !nombre.trim()) { req.flash('error', 'El nombre es obligatorio.'); return res.redirect(`/empleados/${id}/editar`) }
      if (dni && EmpleadosModel.dniEnUso(dni, id)) { req.flash('error', `Ya existe otro empleado con DNI ${dni}.`); return res.redirect(`/empleados/${id}/editar`) }
      setEsChofer(req.body)
      EmpleadosModel.actualizar(id, req.body)
      // Si dejó de ser chofer, liberar sus asignaciones
      if (req.body.es_chofer !== 'true') AsignacionesModel.liberarEmpleado(id)
      req.flash('success', 'Empleado actualizado.')
      res.redirect(`/empleados/${id}`)
    } catch (err) {
      console.error(err); req.flash('error', 'Error al actualizar.'); res.redirect(`/empleados/${req.params.id}/editar`)
    }
  },

  toggleActivo(req, res) {
    try {
      const emp = EmpleadosModel.obtener(req.params.id)
      EmpleadosModel.toggleActivo(req.params.id)
      // Al desactivar, liberar las asignaciones de recursos
      if (emp && emp.activo) AsignacionesModel.liberarEmpleado(req.params.id)
      req.flash('success', 'Estado del empleado actualizado.')
    } catch (err) {
      console.error(err); req.flash('error', 'Error.')
    }
    res.redirect('/empleados')
  },

  // ── Asignación de recursos (camión / máquina) ─────────────────
  asignarRecurso(req, res) {
    const back = `/empleados/${req.params.id}`
    try {
      AsignacionesModel.asignar({
        id_empleado: req.params.id,
        recurso_tipo: req.body.recurso_tipo,
        recurso_id: req.body.recurso_id,
        observaciones: req.body.observaciones,
      })
      req.flash('success', `${req.body.recurso_tipo === 'maquina' ? 'Máquina' : 'Camión'} asignado.`)
    } catch (err) {
      console.error(err); req.flash('error', err.message || 'Error al asignar.')
    }
    res.redirect(back)
  },

  finalizarAsignacion(req, res) {
    try { AsignacionesModel.finalizar(req.params.asigId); req.flash('success', 'Asignación liberada.') }
    catch (err) { console.error(err); req.flash('error', 'Error.') }
    res.redirect(`/empleados/${req.params.id}`)
  },
}

module.exports = EmpleadosController
