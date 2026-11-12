'use strict'
// "Marcar pendiente" / "Marcar como pagada" una operación (ver models/estadoPago.model).
// La pantalla pide primero la vista previa (qué va a cambiar y cuánto queda el saldo) y recién
// después confirma; nada se guarda hasta el POST de confirmación.
const EstadoPago = require('../models/estadoPago.model')
const { leerFechaPago } = require('../utils/fechaPago')

const usuario = (req) => req.session.user?.id

const EstadoPagoController = {

  // GET /estado-pago/:id/vista-previa?accion=pendiente|pagada&metodo_pago=
  async vistaPrevia(req, res) {
    try {
      const { accion, metodo_pago } = req.query
      if (accion === 'pendiente') return res.json(await EstadoPago.vistaPreviaPendiente(req.params.id))
      if (accion === 'pagada') return res.json(await EstadoPago.vistaPreviaPagada(req.params.id, { metodo_pago: metodo_pago || 'efectivo' }))
      res.status(400).json({ error: 'Acción inválida.' })
    } catch (err) {
      console.error(err); res.status(500).json({ error: 'No se pudo calcular el cambio.' })
    }
  },

  async marcarPendiente(req, res) {
    try {
      const r = await EstadoPago.marcarPendiente(req.params.id, { usuario: usuario(req), motivo: req.body.motivo })
      req.flash('success', `${r.nroOp} quedó pendiente de pago.${r.saldoDespues != null ? ' Saldo del cliente: ' + saldoTxt(r.saldoDespues) + '.' : ''}`)
    } catch (err) {
      console.error(err); req.flash('error', err.message || 'No se pudo marcar como pendiente.')
    }
    res.redirect('back')
  },

  async marcarPagada(req, res) {
    try {
      const f = leerFechaPago(req.body.fecha)
      if (f.error) { req.flash('error', f.error); return res.redirect('back') }
      const r = await EstadoPago.marcarPagada(req.params.id, { usuario: usuario(req), metodo_pago: req.body.metodo_pago || 'efectivo', fechaDia: f.fecha })
      req.flash('success', `${r.nroOp} quedó pagada.`)
    } catch (err) {
      console.error(err); req.flash('error', err.message || 'No se pudo marcar como pagada.')
    }
    res.redirect('back')
  },
}

function saldoTxt(s) {
  const n = Math.abs(s).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return s < -0.005 ? `debe $${n}` : (s > 0.005 ? `a favor $${n}` : 'al día')
}

module.exports = EstadoPagoController
