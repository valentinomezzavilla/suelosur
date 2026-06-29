'use strict'
const express = require('express')
const router  = express.Router()
const auth    = require('../middlewares/auth')
const roles   = require('../middlewares/roles')
const ctrl    = require('../controllers/choferes.controller')
const { uploadDocumento } = require('../middlewares/upload')

const acceso = roles('dueno', 'admin_contable')

router.get('/',                 auth, acceso, ctrl.index)
router.get('/dashboard',        auth, acceso, ctrl.dashboard)
router.get('/nuevo',            auth, acceso, ctrl.nuevo)
router.post('/',                auth, acceso, ctrl.crear)
router.get('/reporte/:tipo',    auth, acceso, ctrl.reporte)

router.get('/:id',              auth, acceso, ctrl.detalle)
router.get('/:id/editar',       auth, acceso, ctrl.editar)
router.get('/:id/ubicacion-actual', auth, acceso, ctrl.obtenerUbicacionActual)
router.post('/:id/pago-vencimiento/resolver', auth, acceso, ctrl.resolverPagoVencimiento)
router.put('/:id',              auth, acceso, ctrl.actualizar)
router.post('/:id/baja',        auth, acceso, ctrl.darBaja)
router.post('/:id/reingreso',   auth, acceso, ctrl.reingresar)

// Documentos
router.post('/:id/documentos',                 auth, acceso, uploadDocumento.single('archivo'), ctrl.subirDocumento)
router.get('/:id/documentos/:docId/ver',       auth, acceso, ctrl.verDocumento)
router.post('/:id/documentos/:docId/eliminar', auth, acceso, ctrl.eliminarDocumento)

// Asignaciones de recursos (camión / máquina)
router.post('/:id/asignaciones',                  auth, acceso, ctrl.asignarRecurso)
router.post('/:id/asignaciones/:asigId/finalizar', auth, acceso, ctrl.finalizarAsignacion)

// Control horario
router.post('/:id/horario',                  auth, acceso, ctrl.cargarJornada)
router.post('/:id/horario/:jorId/aprobar',   auth, acceso, ctrl.aprobarJornada)
router.post('/:id/horario/:jorId/eliminar',  auth, acceso, ctrl.eliminarJornada)

// Pagos
router.post('/:id/pagos',                 auth, acceso, ctrl.registrarPago)
router.post('/:id/pagos/:pagoId/eliminar', auth, acceso, ctrl.eliminarPago)

module.exports = router
