'use strict'
const express = require('express')
const router  = express.Router()
const auth    = require('../middlewares/auth')
const roles   = require('../middlewares/roles')
const ctrl    = require('../controllers/compras.controller')

const acceso = roles('admin_ventas', 'admin_contable', 'dueno')

router.get('/',            auth, acceso, ctrl.index)
router.get('/nueva',       auth, acceso, ctrl.nueva)
router.post('/',           auth, acceso, ctrl.crear)
router.post('/pagar-gasto/:gastoId', auth, acceso, ctrl.pagarGasto)
router.post('/:id/eliminar', auth, acceso, ctrl.eliminar)

module.exports = router
