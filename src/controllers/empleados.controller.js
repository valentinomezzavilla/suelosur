'use strict'
const EmpleadosModel = require('../models/empleados.model')
const AsignacionesModel = require('../models/asignaciones.model')
const paginar        = require('../utils/paginar')
const PagosModel     = require('../models/pagos_empleado.model')
const { resolverPeriodo, etiquetaPeriodo } = require('../utils/periodos')
const { hoyISO }     = require('../utils/fecha')
const { leerFechaPago } = require('../utils/fechaPago')
const { ESTADOS: ESTADOS_SUELDO, estadoSueldo, mesValido } = require('../utils/sueldos')

// Deriva es_chofer del cargo seleccionado
const setEsChofer = (body) => { body.es_chofer = (body.cargo === 'Chofer') ? 'true' : '' }

const EmpleadosController = {

  async index(req, res) {
    try {
      const { q, page } = req.query
      const todos = await EmpleadosModel.buscar({ q })
      const { items: empleados, total, page: pag, limit, totalPaginas } = paginar(todos, page, 20)
      // Sueldo del mes de cada empleado: lo establecido en la ficha contra lo pagado (desde la
      // ficha, desde Compras / Pagos o por transferencia de un cliente: todo queda en pagos_empleado)
      const mes = mesValido(req.query.mes) || hoyISO().slice(0, 7)
      const pagosMes = await PagosModel.delMes(mes)
      empleados.forEach(e => {
        const establecido = PagosModel.sueldoEstablecido(e)
        const p = pagosMes[e.id] || { sueldo: 0, otros: 0 }
        e.sueldoMes = { establecido, pagado: p.sueldo, otros: p.otros, estado: estadoSueldo(establecido, p.sueldo) }
      })
      res.render('pages/empleados/index', {
        titulo: 'Flota de Personal', empleados, total, page: pag, limit, totalPaginas,
        filtros: { q: q || '', mes }, mes, estadosSueldo: ESTADOS_SUELDO,
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
      // Pagos y sueldos: por defecto el mes en curso
      const periodo = resolverPeriodo({ preset: req.query.preset || 'mes', desde: req.query.fechaDesde, hasta: req.query.fechaHasta, mes: req.query.mes })
      res.render('pages/empleados/detalle', {
        titulo: `${empleado.nombre} ${empleado.apellido || ''}`.trim(), empleado,
        pagos: await PagosModel.listar(empleado.id, { desde: periodo.desde, hasta: periodo.hasta }),
        resumenPagos: await PagosModel.resumen(empleado.id, { desde: periodo.desde, hasta: periodo.hasta }),
        periodoLabel: etiquetaPeriodo(periodo),
        filtros: { ...req.query, fechaDesde: periodo.desde || '', fechaHasta: periodo.hasta || '', preset: periodo.preset || '' },
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

  // ── Pagos y sueldos ───────────────────────────────────────────
  // Mismo registro que la ficha del chofer y Compras / Pagos: queda en la ficha, en el libro
  // de compras / pagos (y por eso en Transacciones) y genera su recibo.
  async registrarPago(req, res) {
    const back = `/empleados/${req.params.id}#pagos`
    try {
      const { tipo, monto, periodo, descuentos, adiciones, fecha, descripcion, metodo_pago } = req.body
      if (!tipo || !(parseFloat(monto) > 0)) { req.flash('error', 'Elegí el tipo y cargá un monto mayor a cero.'); return res.redirect(back) }
      const leida = leerFechaPago(fecha)
      if (leida.error) { req.flash('error', leida.error); return res.redirect(back) }
      await PagosModel.registrar({
        id_empleado: req.params.id, tipo, periodo: (periodo || '').trim() || null, monto, descuentos, adiciones,
        fecha: leida.fecha, descripcion, metodo_pago: metodo_pago || null, id_usuario: req.session.user?.id || null, origen: 'manual',
      })
      req.flash('success', tipo === 'descuento' ? 'Descuento registrado.' : 'Pago registrado en la ficha, en Compras / Pagos y en Transacciones.')
    } catch (err) { console.error(err); req.flash('error', err.message || 'Error al registrar el pago.') }
    res.redirect(back)
  },

  async eliminarPago(req, res) {
    try {
      await PagosModel.eliminar(req.params.pagoId, req.params.id)
      req.flash('success', 'Pago eliminado.')
    } catch (err) { console.error(err); req.flash('error', err.message || 'No se pudo eliminar el pago.') }
    res.redirect(`/empleados/${req.params.id}#pagos`)
  },
}

module.exports = EmpleadosController
