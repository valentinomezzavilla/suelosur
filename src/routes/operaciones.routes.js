'use strict'
const express = require('express')
const router  = express.Router()
const auth    = require('../middlewares/auth')
const roles   = require('../middlewares/roles')
const ctrl    = require('../controllers/operaciones.controller')

router.post('/:id/recursos', auth, roles('admin_ventas', 'dueno'), ctrl.asignarRecursos)

module.exports = router
