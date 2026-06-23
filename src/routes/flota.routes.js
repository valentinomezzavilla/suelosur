'use strict'
const express = require('express')
const router  = express.Router()
const auth    = require('../middlewares/auth')
const roles   = require('../middlewares/roles')
const ctrl    = require('../controllers/flota.controller')
const { uploadDocumento } = require('../middlewares/upload')

const acceso = roles('dueno', 'admin_contable')

router.get('/',              auth, acceso, ctrl.index)
router.get('/disponibilidad', auth, acceso, ctrl.disponibilidad)
router.get('/nuevo',         auth, acceso, ctrl.nuevo)
router.post('/',             auth, acceso, ctrl.crear)
router.get('/reporte/:tipo', auth, acceso, ctrl.reporte)

router.get('/:id',           auth, acceso, ctrl.detalle)
router.get('/:id/editar',    auth, acceso, ctrl.editar)
router.put('/:id',           auth, acceso, ctrl.actualizar)
router.post('/:id/estado',   auth, acceso, ctrl.cambiarEstado)
router.post('/:id/toggle',   auth, acceso, ctrl.toggleActivo)

// Documentos
router.post('/:id/documentos',                 auth, acceso, uploadDocumento.single('archivo'), ctrl.subirDocumento)
router.get('/:id/documentos/:docId/ver',       auth, acceso, ctrl.verDocumento)
router.post('/:id/documentos/:docId/eliminar', auth, acceso, ctrl.eliminarDocumento)

// Combustible
router.post('/:id/combustible',                  auth, acceso, ctrl.cargarCombustible)
router.post('/:id/combustible/:cargaId/eliminar', auth, acceso, ctrl.eliminarCombustible)

// Mantenimiento
router.post('/:id/mantenimiento',                auth, acceso, uploadDocumento.single('archivo'), ctrl.cargarMantenimiento)
router.get('/:id/mantenimiento/:mid/archivo',    auth, acceso, ctrl.verFacturaMant)
router.post('/:id/mantenimiento/:mid/eliminar',  auth, acceso, ctrl.eliminarMantenimiento)
router.post('/:id/reglas',                       auth, acceso, ctrl.crearRegla)
router.post('/:id/reglas/:reglaId/eliminar',     auth, acceso, ctrl.eliminarRegla)

// Gastos
router.post('/:id/gastos',                auth, acceso, uploadDocumento.single('archivo'), ctrl.cargarGasto)
router.get('/:id/gastos/:gid/archivo',    auth, acceso, ctrl.verComprobanteGasto)
router.post('/:id/gastos/:gid/eliminar',  auth, acceso, ctrl.eliminarGasto)

module.exports = router
