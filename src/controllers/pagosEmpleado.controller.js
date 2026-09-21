'use strict'
// Recibo (PDF) de un pago a empleado. Lo usan dos rutas: la del libro de compras / pagos
// (/compras/recibo/:pagoId) y la de la ficha del chofer (/choferes/:id/pagos/:pagoId/recibo).
const PagosEmpleadoModel = require('../models/pagos_empleado.model')
const { generarReciboPDF } = require('../utils/pdfRecibo')

const PagosEmpleadoController = {
  async recibo(req, res) {
    const back = req.params.id ? `/choferes/${req.params.id}?tab=pagos` : '/compras'
    try {
      const pago = await PagosEmpleadoModel.obtenerConEmpleado(req.params.pagoId)
      // Desde la ficha del chofer, el pago tiene que ser de ese chofer
      if (!pago || (req.params.id && String(pago.id_empleado) !== String(req.params.id))) {
        req.flash('error', 'No se encontró el pago.')
        return res.redirect(back)
      }
      if (pago.tipo === 'descuento') {
        req.flash('error', 'Un descuento suelto no genera recibo.')
        return res.redirect(back)
      }
      return generarReciboPDF(res, pago)
    } catch (err) {
      console.error(err)
      req.flash('error', 'Error al generar el recibo.')
      res.redirect(back)
    }
  },
}

module.exports = PagosEmpleadoController
