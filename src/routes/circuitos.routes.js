'use strict'
const express = require('express')
const router  = express.Router()
const auth    = require('../middlewares/auth')
const roles   = require('../middlewares/roles')
const ctrl    = require('../controllers/circuitos.controller')

const acceso = roles('admin_ventas', 'dueno')

router.get('/',            auth, acceso, ctrl.index)
router.get('/nuevo',       auth, acceso, ctrl.nuevo)
router.post('/',           auth, acceso, ctrl.crear)
router.get('/:id',         auth, acceso, ctrl.detalle)
router.post('/:id/estado', auth, acceso, ctrl.cambiarEstado)
router.post('/:id/eliminar', auth, acceso, ctrl.eliminar)
router.post('/:id/paradas',                  auth, acceso, ctrl.agregarParada)
router.post('/:id/paradas/:paradaId/quitar', auth, acceso, ctrl.quitarParada)
router.post('/:id/paradas/:paradaId/estado', auth, acceso, ctrl.estadoParada)

module.exports = router
