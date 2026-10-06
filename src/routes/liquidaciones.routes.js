'use strict'
const express = require('express')
const router  = express.Router()
const auth    = require('../middlewares/auth')
const roles   = require('../middlewares/roles')
const ctrl    = require('../controllers/liquidaciones.controller')
const acceso  = roles('admin_contable', 'dueno')

router.get('/',    auth, acceso, ctrl.index)
router.get('/pdf', auth, acceso, ctrl.pdf)

module.exports = router
