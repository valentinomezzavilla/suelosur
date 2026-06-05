'use strict'
const express = require('express')
const router  = express.Router()
const auth    = require('../middlewares/auth')
const roles   = require('../middlewares/roles')
const ctrl    = require('../controllers/usuarios.controller')
const soloDueno = roles('dueno')

router.get('/',             auth, soloDueno, ctrl.index)
router.get('/nuevo',        auth, soloDueno, ctrl.nuevo)
router.post('/',            auth, soloDueno, ctrl.crear)
router.get('/:id/editar',   auth, soloDueno, ctrl.editar)
router.put('/:id',          auth, soloDueno, ctrl.actualizar)
router.post('/:id/toggle',  auth, soloDueno, ctrl.toggleActivo)

module.exports = router
