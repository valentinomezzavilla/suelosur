'use strict'
const express = require('express')
const router  = express.Router()
const auth    = require('../middlewares/auth')
const roles   = require('../middlewares/roles')
const ctrl    = require('../controllers/hojaRuta.controller')
const { uploadRemito } = require('../middlewares/upload')

const acceso = roles('chofer', 'admin_ventas', 'dueno')

router.get('/',              auth, acceso, ctrl.index)
// Tracking global del chofer (cualquier página) — debe ir antes de '/:id/...'
router.post('/posicion',     auth, acceso, ctrl.registrarPosicion)
router.post('/:id/iniciar',  auth, acceso, ctrl.iniciar)
router.get('/:id/viaje-en-curso', auth, acceso, ctrl.verEnCurso)
router.post('/:id/ubicacion', auth, acceso, ctrl.guardarUbicacion)
router.post('/:id/geocodificar', auth, acceso, ctrl.geocodificarDestino)
router.get('/ubicacion/actual', auth, roles('chofer', 'admin_ventas', 'dueno'), ctrl.obtenerUbicacionActual)
router.post('/:id/realizar-hoy', auth, acceso, ctrl.realizarHoy)
// Chofer adjunta el remito firmado (imagen o PDF) al finalizar la entrega
router.post('/:id/finalizar', auth, acceso, uploadRemito.single('remito_firmado'), ctrl.finalizar)
// Ver remito firmado guardado
router.get('/:id/remito-firmado', auth, acceso, ctrl.verRemitoFirmado)

module.exports = router
