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

// Sincroniza el efecto del cheque en la cuenta corriente del cliente:
// un cheque RECIBIDO de un cliente, cuando está HABILITADO, acredita su monto
// (movimiento tipo 'pago', suma al saldo). Si deja de estar habilitado, se revierte.
// Devuelve 'creado' | 'revertido' | null. Idempotente (no duplica el crédito).
async function sincronizarImpactoCC(chequeId) {
  const ch = await ChequesModel.obtener(chequeId)
  if (!ch) return null
  const teniaMov = !!ch.id_mov_cuenta
  const debeImpactar = ch.tipo_cartera === 'recibido' && ch.id_cliente && ch.estado === 'habilitado'
  if (teniaMov) {
    await ClientesModel.eliminarMovimiento(ch.id_mov_cuenta)
    await ChequesModel.setMovCuenta(chequeId, null)
  }
  if (debeImpactar) {
    const desc = `Cheque${ch.numero ? ' N° ' + ch.numero : ''}${ch.banco ? ' — ' + ch.banco : ''}`
    const movId = await ClientesModel.agregarMovimiento(ch.id_cliente, {
      tipo: 'pago', descripcion: desc, monto: ch.monto, metodo_pago: 'cheque',
    })
    await ChequesModel.setMovCuenta(chequeId, movId)
    return 'creado'
  }
  return teniaMov ? 'revertido' : null
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
      const id = await ChequesModel.crear({ ...req.body, id_usuario: req.session.user?.id })
      const impacto = await sincronizarImpactoCC(id)
      req.flash('success', impacto === 'creado'
        ? 'Cheque registrado y acreditado en la cuenta del cliente.'
        : 'Cheque registrado en la cartera.')
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
      await sincronizarImpactoCC(req.params.id)
      req.flash('success', 'Cheque actualizado.')
      res.redirect('/cheques')
    } catch (err) { console.error(err); req.flash('error', err.message || 'Error al actualizar.'); res.redirect(`/cheques/${req.params.id}/editar`) }
  },

  async cambiarEstado(req, res) {
    try {
      await ChequesModel.cambiarEstado(req.params.id, req.body.estado)
      const impacto = await sincronizarImpactoCC(req.params.id)
      req.flash('success',
        impacto === 'creado'    ? 'Cheque habilitado y acreditado en la cuenta del cliente.'
      : impacto === 'revertido' ? 'Cheque actualizado. Se revirtió el crédito en la cuenta del cliente.'
      :                           'Estado del cheque actualizado.')
    } catch (err) { console.error(err); req.flash('error', err.message || 'Error al cambiar el estado.') }
    res.redirect('/cheques')
  },

  async eliminar(req, res) {
    try {
      const ch = await ChequesModel.obtener(req.params.id)
      if (ch && ch.id_mov_cuenta) await ClientesModel.eliminarMovimiento(ch.id_mov_cuenta)
      await ChequesModel.eliminar(req.params.id)
      req.flash('success', 'Cheque eliminado.')
    } catch (err) { console.error(err); req.flash('error', 'Error al eliminar.') }
    res.redirect('/cheques')
  },
}

module.exports = ChequesController
