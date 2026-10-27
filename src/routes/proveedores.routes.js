'use strict'
const express = require('express')
const router  = express.Router()
const auth    = require('../middlewares/auth')
const roles   = require('../middlewares/roles')
const ctrl    = require('../controllers/proveedores.controller')
const est     = require('../controllers/estaciones.controller')

const acceso = roles('admin_ventas', 'admin_contable', 'dueno')

router.get('/',             auth, acceso, ctrl.index)
router.get('/nuevo',        auth, acceso, ctrl.nuevo)
router.post('/',            auth, acceso, ctrl.crear)
router.get('/api/buscar',   auth, ctrl.buscarApi)

// Estaciones de servicio: deuda de combustible por estación
router.get('/estaciones',                                  auth, acceso, est.index)
router.get('/estaciones/:id',                              auth, acceso, est.cuenta)
router.post('/estaciones/:id/movimiento',                  auth, acceso, est.agregarMovimiento)
router.post('/estaciones/:id/movimiento/:movId/eliminar',  auth, acceso, est.eliminarMovimiento)
router.post('/estaciones/:id/pago',                        auth, acceso, est.registrarPago)

router.get('/:id/editar',   auth, acceso, ctrl.editar)
router.put('/:id',          auth, acceso, ctrl.actualizar)
router.post('/:id/toggle',  auth, acceso, ctrl.toggleActivo)

module.exports = router
