'use strict'
// Descuentos a clientes: modales de Liquidaciones y Cuenta corriente
const express = require('express')
const router  = express.Router()
const auth    = require('../middlewares/auth')
const roles   = require('../middlewares/roles')
const ctrl    = require('../controllers/descuentos.controller')
const acceso  = roles('admin_contable', 'dueno')

router.get('/opciones',        auth, acceso, ctrl.opciones)
router.post('/vista-previa',   auth, acceso, ctrl.vistaPrevia)
router.post('/',               auth, acceso, ctrl.crear)
router.get('/cliente/:id',     auth, acceso, ctrl.delCliente)
router.post('/:id/revertir',   auth, acceso, ctrl.revertir)

module.exports = router
