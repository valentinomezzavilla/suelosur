'use strict'
const express = require('express')
const router  = express.Router()
const auth    = require('../middlewares/auth')
const roles   = require('../middlewares/roles')
const ctrl    = require('../controllers/remitos.controller')
const { uploadRemito } = require('../middlewares/upload')

const acceso = roles('admin_ventas', 'admin_contable', 'dueno')
const accesoChofer = roles('admin_ventas', 'admin_contable', 'dueno', 'chofer')

// El chofer asignado también puede ver el PDF del remito (validación en el controller)
router.get('/:id/pdf',           auth, accesoChofer, ctrl.pdf)
router.get('/:id/firmado',       auth, accesoChofer, ctrl.verFirmado)
router.post('/:id/firmado',      auth, acceso, uploadRemito.single('archivo'), ctrl.subirFirmado)
router.post('/:id/firmado/eliminar', auth, acceso, ctrl.eliminarFirmado)

module.exports = router
