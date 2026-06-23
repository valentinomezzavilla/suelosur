'use strict'
const express = require('express')
const router  = express.Router()
const auth    = require('../middlewares/auth')
const roles   = require('../middlewares/roles')
const ctrl    = require('../controllers/remitos.controller')
const { uploadRemito } = require('../middlewares/upload')

const acceso = roles('admin_ventas', 'admin_contable', 'dueno')

router.get('/:id/pdf',           auth, acceso, ctrl.pdf)
router.get('/:id/firmado',       auth, acceso, ctrl.verFirmado)
router.post('/:id/firmado',      auth, acceso, uploadRemito.single('archivo'), ctrl.subirFirmado)
router.post('/:id/firmado/eliminar', auth, acceso, ctrl.eliminarFirmado)

module.exports = router
