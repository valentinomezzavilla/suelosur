'use strict'
const express    = require('express')
const router     = express.Router()
const auth       = require('../middlewares/auth')
const roles      = require('../middlewares/roles')
const ctrl       = require('../controllers/contenedores.controller')
const ctrlConfig = require('../controllers/config_contenedores.controller')
const acceso     = roles('admin_ventas', 'dueno')

router.get('/',                 auth, acceso, ctrl.index)
router.get('/circuito',         auth, acceso, ctrl.circuito)
router.get('/configuracion',    auth, roles('dueno'), ctrlConfig.index)
router.post('/configuracion',   auth, roles('dueno'), ctrlConfig.guardar)
router.get('/nuevo',            auth, acceso, ctrl.nuevo)
router.post('/',                auth, acceso, ctrl.crear)
router.get('/:id',              auth, acceso, ctrl.detalle)
router.get('/:id/editar',       auth, acceso, ctrl.editar)
router.put('/:id',              auth, acceso, ctrl.actualizar)
router.post('/:id/toggle',      auth, acceso, ctrl.toggleActivo)
router.post('/:id/movimiento',  auth, acceso, ctrl.registrarMovimiento)

module.exports = router
