'use strict'
const express = require('express')
const router  = express.Router()
const bcrypt  = require('bcryptjs')
const { query } = require('../config/db')

router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/')
  res.render('pages/auth/login', { layout: 'layouts/auth' })
})

router.post('/login', async (req, res) => {
  const { usuario, password } = req.body
  try {
    const user = (await query('SELECT * FROM users WHERE usuario = ? AND activo = 1', [usuario])).rows[0]
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      req.flash('error', 'Usuario o contraseña incorrectos.')
      return res.redirect('/auth/login')
    }
    req.session.user = { id: user.id, nombre: user.nombre, usuario: user.usuario, rol: user.rol }
    const destinos = { dueno: '/dashboard', admin_ventas: '/ventas', admin_contable: '/cobranzas', chofer: '/hoja-de-ruta' }
    // Volver al deep-link pedido antes del login (si lo hay); si no, al inicio por rol.
    const returnTo = req.session.returnTo
    delete req.session.returnTo
    req.flash('success', `Bienvenido, ${user.nombre}`)
    res.redirect(returnTo || destinos[user.rol] || '/ventas')
  } catch (err) {
    console.error(err)
    req.flash('error', 'Error interno.')
    res.redirect('/auth/login')
  }
})

router.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/auth/login'))
})

module.exports = router
