'use strict'
const express = require('express')
const router  = express.Router()
const auth    = require('../middlewares/auth')
const roles   = require('../middlewares/roles')
const ctrl    = require('../controllers/facturacion.controller')

const contable  = roles('admin_contable', 'dueno')
// Marcar / quitar "para facturar" también lo hace quien carga las operaciones
const operativo = roles('admin_ventas', 'admin_contable', 'dueno')

router.get('/',                   auth, contable,  ctrl.index)
router.get('/exportar/:formato',  auth, contable,  ctrl.exportar)
router.post('/facturar',          auth, contable,  ctrl.facturar)
router.post('/:id/marcar',        auth, operativo, ctrl.marcar)
router.post('/:id/quitar',        auth, operativo, ctrl.quitar)
router.post('/:id/revertir',      auth, contable,  ctrl.revertir)
router.post('/:id/nota-credito',  auth, contable,  ctrl.notaCredito)

module.exports = router
