'use strict'
const express = require('express')
const router  = express.Router()
const auth    = require('../middlewares/auth')
const roles   = require('../middlewares/roles')
const ctrl    = require('../controllers/estadoPago.controller')
// Igual que anular un pago: solo dueño y administración contable
const acceso  = roles('admin_contable', 'dueno')

router.get('/:id/vista-previa',     auth, acceso, ctrl.vistaPrevia)
router.post('/:id/marcar-pendiente', auth, acceso, ctrl.marcarPendiente)
router.post('/:id/marcar-pagada',    auth, acceso, ctrl.marcarPagada)

module.exports = router
