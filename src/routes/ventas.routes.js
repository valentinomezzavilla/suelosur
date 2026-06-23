'use strict'
const express    = require('express')
const router     = express.Router()
const auth       = require('../middlewares/auth')
const roles      = require('../middlewares/roles')
const ctrl       = require('../controllers/ventas.controller')
const acceso     = roles('admin_ventas', 'dueno')

router.get('/',                    auth, acceso, ctrl.index)
router.get('/cantera',             auth, acceso, ctrl.cantera)
router.post('/finalizar-cantera',  auth, acceso, ctrl.finalizarCantera)
router.get('/cantera/confirmacion',auth, acceso, ctrl.confirmacionCantera)
router.get('/viaje',               auth, acceso, ctrl.viaje)
router.post('/crear-viaje',        auth, acceso, ctrl.crearViaje)
router.get('/:id',                 auth, acceso, ctrl.detalle)
router.get('/:id/editar',          auth, acceso, ctrl.editarViaje)
router.put('/:id',                 auth, acceso, ctrl.actualizarViaje)
router.post('/:id/editar',         auth, acceso, ctrl.actualizarViaje)
router.get('/:id/remito',          auth, acceso, ctrl.remito)
router.post('/:id/despachar',      auth, acceso, ctrl.despachar)
router.post('/:id/entregar',       auth, acceso, ctrl.entregar)
router.post('/:id/anular',         auth, acceso, ctrl.anular)

// API JSON (buscarCliente.js del front)
router.get('/api/buscar-clientes', auth, acceso, ctrl.buscarClientesApi)
router.post('/api/crear-cliente',  auth, acceso, ctrl.crearClienteApi)

// API JSON: asignación chofer ↔ camión (autocomplete recíproco en el form)
router.get('/api/chofer-de-camion/:idCamion', auth, acceso, ctrl.apiChoferDeCamion)
router.get('/api/camion-de-chofer/:idChofer', auth, acceso, ctrl.apiCamionDeChofer)

module.exports = router
