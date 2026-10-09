'use strict'
const express = require('express')
const router  = express.Router()
const auth    = require('../middlewares/auth')
const Tercero = require('../services/tercero.service')

// Opciones de los desplegables de "Destinado a tercero" (public/js/terceroTransferencia.js)
router.get('/opciones', auth, async (req, res) => {
  try { res.json(await Tercero.opciones()) } catch (err) {
    console.error(err); res.status(500).json({ error: 'No se pudieron cargar las opciones.' })
  }
})

module.exports = router
