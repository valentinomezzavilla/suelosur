'use strict'
const EmpleadosModel = require('../models/empleados.model')
const AsignacionesModel = require('../models/asignaciones.model')
const paginar        = require('../utils/paginar')

// Deriva es_chofer del cargo seleccionado
const setEsChofer = (body) => { body.es_chofer = (body.cargo === 'Chofer') ? 'true' : '' }

const EmpleadosController = {

  async index(req, res) {
    try {
      const { q, page } = req.query
      const todos = await EmpleadosModel.buscar({ q })
      const { items: empleados, total, page: pag, limit, totalPaginas } = paginar(todos, page, 20)
      res.render('pages/empleados/index', {
        titulo: 'Flota de Personal', empleados, total, page: pag, limit, totalPaginas,
        filtros: { q: q || '' },
      })
    } catch (err) {
      console.error(err); req.flash('error', 'Error al cargar el personal.'); res.redirect('back')
    }
  },

  async nuevo(req, res) {
    res.render('pages/empleados/form', {
      titulo: 'Nuevo Empleado', empleado: null,
      usuarios: await EmpleadosModel.usuariosVinculables(),
    })
  },

  async crear(req, res) {
    try {
      const { nombre, dni } = req.body
      if (!nombre || !nombre.trim()) { req.flash('error', 'El nombre es obligatorio.'); return res.redirect('/empleados/nuevo') }
      if (dni && await EmpleadosModel.dniEnUso(dni)) { req.flash('error', `Ya existe un empleado con DNI ${dni}.`); return res.redirect('/empleados/nuevo') }
      setEsChofer(req.body)
      await EmpleadosModel.crear(req.body)
      req.flash('success', `Empleado ${nombre} creado.`)
      res.redirect('/empleados')
    } catch (err) {
      console.error(err); req.flash('error', 'Error al crear el empleado.'); res.redirect('/empleados/nuevo')
    }
  },

  async detalle(req, res) {
    try {
      const empleado = await EmpleadosModel.obtener(req.params.id)
      if (!empleado) { req.flash('error', 'Empleado no encontrado.'); return res.redirect('/empleados') }
      res.render('pages/empleados/detalle', {
        titulo: `${empleado.nombre} ${empleado.apellido || ''}`.trim(), empleado,
        asignacionesActivas: await AsignacionesModel.activas(empleado.id),
        asignacionesHist: await AsignacionesModel.historialEmpleado(empleado.id),
        camionesDisp: await AsignacionesModel.camionesDisponibles(),
        maquinasDisp: await AsignacionesModel.maquinasDisponibles(),
      })
    } catch (err) {
      console.error(err); req.flash('error', 'Error.'); res.redirect('/empleados')
    }
  },

  async editar(req, res) {
    try {
      const empleado = await EmpleadosModel.obtener(req.params.id)
      if (!empleado) { req.flash('error', 'Empleado no encontrado.'); return res.redirect('/empleados') }
      res.render('pages/empleados/form', {
        titulo: 'Editar Empleado', empleado,
        usuarios: await EmpleadosModel.usuariosVinculables(empleado.id),
      })
    } catch (err) {
      console.error(err); req.flash('error', 'Error.'); res.redirect('/empleados')
    }
  },

  async actualizar(req, res) {
    try {
      const id = req.params.id
      const { nombre, dni } = req.body
      if (!nombre || !nombre.trim()) { req.flash('error', 'El nombre es obligatorio.'); return res.redirect(`/empleados/${id}/editar`) }
      if (dni && await EmpleadosModel.dniEnUso(dni, id)) { req.flash('error', `Ya existe otro empleado con DNI ${dni}.`); return res.redirect(`/empleados/${id}/editar`) }
      setEsChofer(req.body)
      await EmpleadosModel.actualizar(id, req.body)
      // Si dejó de ser chofer, liberar sus asignaciones
      if (req.body.es_chofer !== 'true') await AsignacionesModel.liberarEmpleado(id)
      req.flash('success', 'Empleado actualizado.')
      res.redirect(`/empleados/${id}`)
    } catch (err) {
      console.error(err); req.flash('error', 'Error al actualizar.'); res.redirect(`/empleados/${req.params.id}/editar`)
    }
  },

  async toggleActivo(req, res) {
    try {
      const emp = await EmpleadosModel.obtener(req.params.id)
      await EmpleadosModel.toggleActivo(req.params.id)
      // Al desactivar, liberar las asignaciones de recursos
      if (emp && emp.activo) await AsignacionesModel.liberarEmpleado(req.params.id)
      req.flash('success', 'Estado del empleado actualizado.')
    } catch (err) {
      console.error(err); req.flash('error', 'Error.')
    }
    res.redirect('/empleados')
  },

  // ── Asignación de recursos (camión / máquina) ─────────────────
  async asignarRecurso(req, res) {
    const back = `/empleados/${req.params.id}`
    try {
      await AsignacionesModel.asignar({
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

  async finalizarAsignacion(req, res) {
    try { await AsignacionesModel.finalizar(req.params.asigId); req.flash('success', 'Asignación liberada.') }
    catch (err) { console.error(err); req.flash('error', 'Error.') }
    res.redirect(`/empleados/${req.params.id}`)
  },
}

module.exports = EmpleadosController
