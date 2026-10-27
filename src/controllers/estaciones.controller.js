'use strict'
const EstacionesModel = require('../models/estaciones.model')
const EgresosModel    = require('../models/egresos.model')

const fechaISO = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : ''
const METODOS = ['efectivo', 'transferencia', 'cheque', 'echeq']

const EstacionesController = {

  async index(req, res) {
    try {
      const estaciones = await EstacionesModel.resumen({ incluirInactivas: req.query.inactivas === '1' })
      res.render('pages/proveedores/estaciones', {
        titulo: 'Estaciones de servicio', estaciones,
        totalDeuda: estaciones.reduce((a, e) => a + Math.max(e.saldo, 0), 0),
        filtros: { inactivas: req.query.inactivas === '1' },
      })
    } catch (err) { console.error(err); req.flash('error', 'Error al cargar las estaciones.'); res.redirect('/proveedores') }
  },

  async cuenta(req, res) {
    try {
      const estacion = await EstacionesModel.obtener(req.params.id)
      if (!estacion) { req.flash('error', 'La estación no existe (o el proveedor no está marcado como estación de servicio).'); return res.redirect('/proveedores/estaciones') }
      const filtros = { desde: fechaISO(req.query.desde), hasta: fechaISO(req.query.hasta) }
      res.render('pages/proveedores/estacion_cuenta', {
        titulo: 'Estaciones de servicio', estacion, filtros,
        cuenta: await EstacionesModel.cuenta(estacion.id, { desde: filtros.desde || null, hasta: filtros.hasta || null }),
        total: await EstacionesModel.cuenta(estacion.id),
      })
    } catch (err) { console.error(err); req.flash('error', 'Error al cargar la cuenta.'); res.redirect('/proveedores/estaciones') }
  },

  // Cargo manual (ej. el resumen del mes) o ajuste a favor
  async agregarMovimiento(req, res) {
    const back = `/proveedores/estaciones/${req.params.id}`
    try {
      if (!(await EstacionesModel.obtener(req.params.id))) throw new Error('La estación no existe.')
      const { tipo, monto, descripcion, fecha } = req.body
      await EstacionesModel.agregarMovimiento(req.params.id, { tipo, monto, descripcion, fecha, id_usuario: req.session.user?.id })
      req.flash('success', tipo === 'cargo' ? 'Cargo registrado: la deuda aumentó.' : 'Ajuste registrado: la deuda bajó.')
    } catch (err) { console.error(err); req.flash('error', err.message || 'Error al registrar.') }
    res.redirect(back)
  },

  async eliminarMovimiento(req, res) {
    try { await EstacionesModel.eliminarMovimiento(req.params.id, req.params.movId); req.flash('success', 'Movimiento eliminado.') }
    catch (err) { console.error(err); req.flash('error', err.message || 'Error al eliminar.') }
    res.redirect(`/proveedores/estaciones/${req.params.id}`)
  },

  // Pago hecho por la empresa: queda en Compras / Pagos (Combustible) y baja la deuda
  async registrarPago(req, res) {
    const back = `/proveedores/estaciones/${req.params.id}`
    try {
      const estacion = await EstacionesModel.obtener(req.params.id)
      if (!estacion) throw new Error('La estación no existe.')
      const monto = Math.round((Number(req.body.monto) || 0) * 100) / 100
      if (!(monto > 0)) throw new Error('Ingresá un monto mayor a cero.')
      const metodo = METODOS.includes(req.body.metodo_pago) ? req.body.metodo_pago : 'efectivo'
      const detalle = String(req.body.descripcion || '').trim()
      await EgresosModel.crear({
        fecha: fechaISO(req.body.fecha) || null, categoria: 'combustible', monto, metodo_pago: metodo,
        descripcion: `Pago a ${estacion.nombre}` + (detalle ? ` — ${detalle}` : ''),
        id_proveedor: estacion.id, origen: 'manual', id_usuario: req.session.user?.id,
      })
      req.flash('success', 'Pago registrado en Compras / Pagos: la deuda con la estación bajó.')
    } catch (err) { console.error(err); req.flash('error', err.message || 'Error al registrar el pago.') }
    res.redirect(back)
  },
}

module.exports = EstacionesController
