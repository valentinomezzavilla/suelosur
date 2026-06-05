'use strict'
const express    = require('express')
const router     = express.Router()
const auth       = require('../middlewares/auth')
const roles      = require('../middlewares/roles')
const ctrl       = require('../controllers/clientes.controller')
const acceso     = roles('admin_ventas', 'dueno')

router.get('/',                  auth, acceso, ctrl.index)
router.get('/nuevo',             auth, acceso, ctrl.nuevo)
router.post('/',                 auth, acceso, ctrl.crear)
router.get('/api/buscar',        auth, ctrl.buscarApi)
router.post('/api/crear',        auth, ctrl.crearApi)
router.get('/:id',               auth, acceso, ctrl.detalle)
router.get('/:id/editar',        auth, acceso, ctrl.editar)
router.put('/:id',               auth, acceso, ctrl.actualizar)
router.post('/:id/toggle',       auth, acceso, ctrl.toggleActivo)
router.post('/:id/habilitar-cuenta', auth, acceso, ctrl.habilitarCuenta)
router.post('/:id/abonar',       auth, acceso, ctrl.abonar)

module.exports = router
