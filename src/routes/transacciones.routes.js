'use strict'
const express = require('express')
const router  = express.Router()
const auth    = require('../middlewares/auth')
const roles   = require('../middlewares/roles')
const ctrl    = require('../controllers/transacciones.controller')

router.get('/', auth, roles('admin_ventas','admin_contable','dueno'), ctrl.index)

module.exports = router
