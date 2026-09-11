'use strict'
const express = require('express')
const multer  = require('multer')
const router  = express.Router()
const auth    = require('../middlewares/auth')
const roles   = require('../middlewares/roles')
const ctrl    = require('../controllers/facturacion.controller')

const contable  = roles('admin_contable', 'dueno')
// Marcar / quitar "para facturar" también lo hace quien carga las operaciones
const operativo = roles('admin_ventas', 'admin_contable', 'dueno')
// Certificado y clave privada: solo el dueño
const soloDueno = roles('dueno')

const uploadCredenciales = multer({ storage: multer.memoryStorage(), limits: { fileSize: 64 * 1024, files: 2 } })
  .fields([{ name: 'cert_file', maxCount: 1 }, { name: 'key_file', maxCount: 1 }])
const subirCredenciales = (req, res, next) => uploadCredenciales(req, res, (err) => {
  if (!err) return next()
  req.flash('error', 'No se pudo leer el archivo (máximo 64 KB).')
  res.redirect('/facturacion/configuracion')
})

router.get('/',                        auth, contable,  ctrl.index)
router.get('/exportar/:formato',       auth, contable,  ctrl.exportar)
router.get('/configuracion',           auth, soloDueno, ctrl.configuracion)
router.post('/configuracion',          auth, soloDueno, subirCredenciales, ctrl.guardarConfiguracion)
router.post('/configuracion/probar',   auth, soloDueno, ctrl.probarConexion)
router.post('/facturar',               auth, contable,  ctrl.facturar)
router.post('/:id/marcar',             auth, operativo, ctrl.marcar)
router.post('/:id/quitar',             auth, operativo, ctrl.quitar)
router.post('/:id/revertir',           auth, contable,  ctrl.revertir)
router.post('/:id/nota-credito',       auth, contable,  ctrl.notaCredito)

module.exports = router
