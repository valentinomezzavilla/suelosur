'use strict'
const express = require('express')
const router  = express.Router()
const auth    = require('../middlewares/auth')
const roles   = require('../middlewares/roles')
const ctrl    = require('../controllers/cheques.controller')

const acceso = roles('admin_ventas', 'admin_contable', 'dueno')

router.get('/',                auth, acceso, ctrl.index)
router.get('/nuevo',           auth, acceso, ctrl.nuevo)
router.post('/',               auth, acceso, ctrl.crear)
router.get('/:id/editar',      auth, acceso, ctrl.editar)
router.post('/:id',            auth, acceso, ctrl.actualizar)
router.post('/:id/estado',     auth, acceso, ctrl.cambiarEstado)
router.post('/:id/eliminar',   auth, acceso, ctrl.eliminar)

module.exports = router
