'use strict'
const express = require('express')
const router  = express.Router()
const auth    = require('../middlewares/auth')
const roles   = require('../middlewares/roles')
const ctrl    = require('../controllers/alertas.controller')

const acceso = roles('dueno', 'admin_contable')

router.get('/',        auth, acceso, ctrl.index)
router.get('/export',  auth, acceso, ctrl.exportar)
router.post('/config', auth, acceso, ctrl.guardarConfig)

module.exports = router
