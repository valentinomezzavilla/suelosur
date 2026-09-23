'use strict'
const express = require('express')
const router  = express.Router()
const auth    = require('../middlewares/auth')
const roles   = require('../middlewares/roles')
const ctrl    = require('../controllers/compras.controller')
const catCtrl = require('../controllers/categoriasEgreso.controller')
const pagosCtrl = require('../controllers/pagosEmpleado.controller')

const acceso = roles('admin_ventas', 'admin_contable', 'dueno')

// Administrar categorías (antes de '/nueva' y '/:id' para que no choquen las rutas)
router.get('/categorias',            auth, acceso, catCtrl.index)
router.get('/categorias/nueva',      auth, acceso, catCtrl.nueva)
router.post('/categorias',           auth, acceso, catCtrl.crear)
router.get('/categorias/:id/editar', auth, acceso, catCtrl.editar)
router.put('/categorias/:id',        auth, acceso, catCtrl.actualizar)
router.post('/categorias/:id/toggle',   auth, acceso, catCtrl.toggle)
router.delete('/categorias/:id',     auth, acceso, catCtrl.eliminar)

router.get('/',            auth, acceso, ctrl.index)
router.get('/nueva',       auth, acceso, ctrl.nueva)
router.post('/',           auth, acceso, ctrl.crear)
router.post('/pagar-gasto/:gastoId', auth, acceso, ctrl.pagarGasto)
router.get('/recibo/:pagoId', auth, acceso, pagosCtrl.recibo)
router.post('/:id/eliminar', auth, acceso, ctrl.eliminar)

module.exports = router
