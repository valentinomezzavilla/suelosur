'use strict'
const express = require('express')
const router  = express.Router()
const auth    = require('../middlewares/auth')
const roles   = require('../middlewares/roles')
const ctrl    = require('../controllers/empleados.controller')
const acceso  = roles('dueno')

router.get('/',              auth, acceso, ctrl.index)
router.get('/nuevo',         auth, acceso, ctrl.nuevo)
router.post('/',             auth, acceso, ctrl.crear)
router.get('/:id',           auth, acceso, ctrl.detalle)
router.get('/:id/editar',    auth, acceso, ctrl.editar)
router.put('/:id',           auth, acceso, ctrl.actualizar)
router.post('/:id/toggle',   auth, acceso, ctrl.toggleActivo)
router.post('/:id/asignaciones',                   auth, acceso, ctrl.asignarRecurso)
router.post('/:id/asignaciones/:asigId/finalizar', auth, acceso, ctrl.finalizarAsignacion)

module.exports = router
