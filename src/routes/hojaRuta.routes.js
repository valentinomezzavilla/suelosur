'use strict'
const express = require('express')
const router  = express.Router()
const auth    = require('../middlewares/auth')
const roles   = require('../middlewares/roles')
const ctrl    = require('../controllers/hojaRuta.controller')
const { uploadRemito } = require('../middlewares/upload')

const acceso = roles('chofer', 'admin_ventas', 'dueno')

router.get('/',              auth, acceso, ctrl.index)
router.post('/:id/iniciar',  auth, acceso, ctrl.iniciar)
router.post('/:id/realizar-hoy', auth, acceso, ctrl.realizarHoy)
// Chofer adjunta el remito firmado (imagen o PDF) al finalizar la entrega
router.post('/:id/finalizar', auth, acceso, uploadRemito.single('remito_firmado'), ctrl.finalizar)
// Ver remito firmado guardado
router.get('/:id/remito-firmado', auth, acceso, ctrl.verRemitoFirmado)

module.exports = router
