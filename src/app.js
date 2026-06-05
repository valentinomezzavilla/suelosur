const express        = require('express')
const expressLayouts = require('express-ejs-layouts')
const session        = require('express-session')
const flash          = require('connect-flash')
const methodOverride = require('method-override')
const path           = require('path')

const app = express()

// ── Motor de vistas ──────────────────────────────────────────────
app.set('view engine', 'ejs')
app.set('views', path.join(__dirname, '..', 'views'))
app.use(expressLayouts)
app.set('layout', 'layouts/main')

// ── Middlewares globales ─────────────────────────────────────────
app.use(express.urlencoded({ extended: true }))
app.use(express.json())
app.use(methodOverride((req) => req.query._method || (req.body && req.body._method)))
app.use(express.static(path.join(__dirname, '..', 'public')))

// ── Sesión ───────────────────────────────────────────────────────
app.use(session({
  secret: process.env.SESSION_SECRET || 'suelosur-dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 8 } // 8 horas
}))

// ── Flash messages ───────────────────────────────────────────────
app.use(flash())

// ── Variables globales para todas las vistas ─────────────────────
app.use((req, res, next) => {
  res.locals.user    = req.session.user || null
  res.locals.success = req.flash('success')
  res.locals.error   = req.flash('error')
  res.locals.warning = req.flash('warning')
  // helper formatFecha para compatibilidad con vistas de Seminario
  res.locals.formatFecha = (fecha) => {
    if (!fecha) return ''
    const [y, m, d] = String(fecha).split('-')
    return d && m && y ? `${d}-${m}-${y}` : fecha
  }
  next()
})

// ── Rutas ────────────────────────────────────────────────────────
const auth = require('./middlewares/auth')
const roles = require('./middlewares/roles')

app.use('/auth',          require('./routes/auth.routes'))
app.use('/ventas',        require('./routes/ventas.routes'))
app.use('/alquileres',    require('./routes/alquileres.routes'))
app.use('/contenedores',  require('./routes/contenedores.routes'))
app.use('/maquinaria',    require('./routes/maquinaria.routes'))
app.use('/clientes',      require('./routes/clientes.routes'))
app.use('/stock',         require('./routes/stock.routes'))
app.use('/productos',     require('./routes/productos.routes'))
app.use('/transacciones', require('./routes/transacciones.routes'))
app.use('/usuarios',      require('./routes/usuarios.routes'))
app.use('/empleados',     require('./routes/empleados.routes'))
app.use('/circuitos',     require('./routes/circuitos.routes'))

// ── Placeholders (módulos futuros) ───────────────────────────────
const placeholder = (titulo, icono, sprint) => (req, res) =>
  res.render('pages/placeholder', { titulo, icono, sprint })

app.get('/dashboard',   auth, roles('dueno'), placeholder('Dashboard', '📊', 7))
app.get('/cobranzas',   auth, roles('admin_contable','dueno'), placeholder('Cobranzas', '💰', 4))
app.get('/facturacion', auth, roles('admin_contable','dueno'), placeholder('Facturación', '🧾', 6))
app.get('/flota',       auth, roles('dueno'), placeholder('Flota Camiones', '🚚', 6))
app.get('/compras',     auth, roles('admin_ventas','dueno'), placeholder('Compras', '🛒', 5))
app.get('/hoja-de-ruta',auth, roles('chofer','admin_ventas','dueno'), placeholder('Hoja de Ruta', '🗺️', 3))

// ── Ruta raíz ────────────────────────────────────────────────────
app.get('/', (req, res) => {
  if (!req.session.user) return res.redirect('/auth/login')
  const destinos = {
    dueno:          '/dashboard',
    admin_ventas:   '/ventas',
    admin_contable: '/cobranzas',
    chofer:         '/hoja-de-ruta',
  }
  res.redirect(destinos[req.session.user.rol] || '/ventas')
})

// ── Chrome DevTools (evita 404) ──────────────────────────────────
app.get('/.well-known/appspecific/com.chrome.devtools.json', (req, res) => res.status(204).end())

// ── 404 ──────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).render('pages/error', {
    layout: 'layouts/main',
    titulo: 'No encontrado',
    mensaje: 'Página no encontrada.'
  })
})

// ── Error handler ────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error(err)
  res.status(err.status || 500).render('pages/error', {
    layout: 'layouts/main',
    titulo: 'Error',
    mensaje: err.message || 'Error interno del servidor.'
  })
})

module.exports = app
