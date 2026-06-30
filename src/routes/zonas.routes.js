'use strict'
const express = require('express')
const router  = express.Router()
const auth    = require('../middlewares/auth')
const roles   = require('../middlewares/roles')
const ctrl    = require('../controllers/zonas.controller')

const acceso = roles('dueno', 'admin_ventas', 'admin_contable')

router.get('/',             auth, acceso, ctrl.config)
router.post('/tarifas',     auth, acceso, ctrl.guardarTarifas)
router.get('/planificador', auth, acceso, ctrl.planificador)

module.exports = router
