'use strict'
const express = require('express')
const router  = express.Router()
const auth    = require('../middlewares/auth')
const roles   = require('../middlewares/roles')
const ctrl    = require('../controllers/hojaRuta.controller')

const acceso = roles('chofer', 'admin_ventas', 'dueno')

router.get('/',              auth, acceso, ctrl.index)
router.post('/:id/iniciar',  auth, acceso, ctrl.iniciar)
router.post('/:id/finalizar', auth, acceso, ctrl.finalizar)

module.exports = router
