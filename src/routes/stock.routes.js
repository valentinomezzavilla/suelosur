'use strict'
const express = require('express')
const router  = express.Router()
const auth    = require('../middlewares/auth')
const roles   = require('../middlewares/roles')
const ctrl    = require('../controllers/stock.controller')
const acceso  = roles('admin_ventas', 'dueno')

router.get('/',        auth, acceso, ctrl.index)
router.get('/egreso',  auth, acceso, ctrl.egresoPage)
router.post('/:id_producto/ajustar', auth, acceso, ctrl.ajustar)
router.post('/:id_producto/ingreso', auth, acceso, ctrl.ingreso)
router.post('/:id_producto/egreso',  auth, acceso, ctrl.egreso)

module.exports = router
