'use strict'
const express = require('express')
const router  = express.Router()
const auth    = require('../middlewares/auth')
const roles   = require('../middlewares/roles')

router.get('/', auth, roles('admin_ventas','chofer','dueno'), (req, res) => {
  res.render('pages/circuitos/index', { titulo: 'Circuitos Logísticos' })
})

module.exports = router
