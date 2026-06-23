'use strict'
const express    = require('express')
const router     = express.Router()
const auth       = require('../middlewares/auth')
const roles      = require('../middlewares/roles')
const ctrlCont   = require('../controllers/alquileres.controller')
const ctrlMaq    = require('../controllers/alquileres_maquinaria.controller')
const acceso     = roles('admin_ventas', 'dueno')

// ── Índice general: redirige a sub-secciones ──────────────────
router.get('/', auth, acceso, (req, res) => res.redirect('/alquileres/contenedores'))

// ── Alquileres de contenedores ────────────────────────────────
router.get('/contenedores',                      auth, acceso, ctrlCont.index)
router.get('/contenedores/nuevo',                auth, acceso, ctrlCont.nuevo)
router.post('/contenedores',                     auth, acceso, ctrlCont.crear)
router.get('/contenedores/:id',                  auth, acceso, ctrlCont.detalle)
router.get('/contenedores/:id/editar',           auth, acceso, ctrlCont.editar)
router.put('/contenedores/:id',                  auth, acceso, ctrlCont.actualizar)
router.post('/contenedores/:id/asignar',         auth, acceso, ctrlCont.asignarContenedor)
router.post('/contenedores/:id/despachar',       auth, acceso, ctrlCont.despachar)
router.post('/contenedores/:id/entregar',        auth, acceso, ctrlCont.entregar)
router.post('/contenedores/:id/retirar',         auth, acceso, ctrlCont.retirar)
router.post('/contenedores/:id/devolver',        auth, acceso, ctrlCont.devolverAPlanta)
router.post('/contenedores/:id/anular',          auth, acceso, ctrlCont.anular)

// ── Alquileres de maquinaria ──────────────────────────────────
router.get('/maquinaria',                        auth, acceso, ctrlMaq.index)
router.get('/maquinaria/nuevo',                  auth, acceso, ctrlMaq.nuevo)
router.post('/maquinaria',                       auth, acceso, ctrlMaq.crear)
router.get('/maquinaria/:id',                    auth, acceso, ctrlMaq.detalle)
router.get('/maquinaria/:id/editar',             auth, acceso, ctrlMaq.editar)
router.put('/maquinaria/:id',                    auth, acceso, ctrlMaq.actualizar)
router.post('/maquinaria/:id/asignar',           auth, acceso, ctrlMaq.asignarMaquinaria)
router.post('/maquinaria/:id/despachar',         auth, acceso, ctrlMaq.despachar)
router.post('/maquinaria/:id/entregar',          auth, acceso, ctrlMaq.entregar)
router.post('/maquinaria/:id/retirar',           auth, acceso, ctrlMaq.retirar)
router.post('/maquinaria/:id/devolver',          auth, acceso, ctrlMaq.devolverAPlanta)
router.post('/maquinaria/:id/anular',            auth, acceso, ctrlMaq.anular)

module.exports = router
