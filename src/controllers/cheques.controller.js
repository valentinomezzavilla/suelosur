'use strict'
const ChequesModel     = require('../models/cheques.model')
const ClientesModel    = require('../models/clientes.model')
const ProveedoresModel = require('../models/proveedores.model')
const EmpleadosModel   = require('../models/empleados.model')

async function datosForm() {
  return {
    clientes:    await ClientesModel.listar(),
    proveedores: await ProveedoresModel.listar(),
    empleados:   await EmpleadosModel.listar(),
  }
}

const ChequesController = {

  async index(req, res) {
    try {
      const { tipo_cartera, estado, tipo, q } = req.query
      res.render('pages/cheques/index', {
        titulo: 'Cheques',
        cheques: await ChequesModel.listar({ tipo_cartera, estado, tipo, q }),
        resumen: await ChequesModel.resumen(),
        estados: ChequesModel.ESTADOS,
        filtros: { tipo_cartera: tipo_cartera || '', estado: estado || '', tipo: tipo || '', q: q || '' },
      })
    } catch (err) { console.error(err); req.flash('error', 'Error al cargar los cheques.'); res.redirect('/') }
  },

  async nuevo(req, res) {
    res.render('pages/cheques/form', {
      titulo: 'Nuevo cheque', cheque: null,
      ...(await datosForm()),
    })
  },

  async crear(req, res) {
    try {
      if (!(parseFloat(req.body.monto) > 0)) { req.flash('error', 'Ingresá un monto válido.'); return res.redirect('/cheques/nuevo') }
      await ChequesModel.crear({ ...req.body, id_usuario: req.session.user?.id })
      req.flash('success', 'Cheque registrado en la cartera.')
      res.redirect('/cheques')
    } catch (err) { console.error(err); req.flash('error', err.message || 'Error al registrar el cheque.'); res.redirect('/cheques/nuevo') }
  },

  async editar(req, res) {
    try {
      const cheque = await ChequesModel.obtener(req.params.id)
      if (!cheque) { req.flash('error', 'Cheque no encontrado.'); return res.redirect('/cheques') }
      res.render('pages/cheques/form', { titulo: `Editar cheque`, cheque, ...(await datosForm()) })
    } catch (err) { console.error(err); req.flash('error', 'Error.'); res.redirect('/cheques') }
  },

  async actualizar(req, res) {
    try {
      await ChequesModel.actualizar(req.params.id, req.body)
      req.flash('success', 'Cheque actualizado.')
      res.redirect('/cheques')
    } catch (err) { console.error(err); req.flash('error', err.message || 'Error al actualizar.'); res.redirect(`/cheques/${req.params.id}/editar`) }
  },

  async cambiarEstado(req, res) {
    try {
      await ChequesModel.cambiarEstado(req.params.id, req.body.estado)
      req.flash('success', 'Estado del cheque actualizado.')
    } catch (err) { console.error(err); req.flash('error', err.message || 'Error al cambiar el estado.') }
    res.redirect('/cheques')
  },

  async eliminar(req, res) {
    try {
      await ChequesModel.eliminar(req.params.id)
      req.flash('success', 'Cheque eliminado.')
    } catch (err) { console.error(err); req.flash('error', 'Error al eliminar.') }
    res.redirect('/cheques')
  },
}

module.exports = ChequesController
