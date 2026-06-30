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

// ── Trust proxy (Render / Heroku / etc. usan reverse proxy HTTPS) ─
if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1)
}

// ── Sesión ───────────────────────────────────────────────────────
app.use(session({
  secret: process.env.SESSION_SECRET || 'suelosur-dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 1000 * 60 * 60 * 8, // 8 horas
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
  },
}))

// ── Flash messages ───────────────────────────────────────────────
app.use(flash())

// ── Variables globales para todas las vistas ─────────────────────
const { icon } = require('./config/icons')
const { fmtFecha, fmtFechaHora } = require('./utils/fecha')
app.use((req, res, next) => {
  res.locals.user    = req.session.user || null
  res.locals.icon    = icon
  res.locals.success = req.flash('success')
  res.locals.error   = req.flash('error')
  res.locals.warning = req.flash('warning')
  // Formato único de fechas: DD/MM/AAAA (acepta ISO, datetime y dd-mm-aaaa)
  res.locals.formatFecha = fmtFecha
  res.locals.formatFechaHora = fmtFechaHora
  res.locals.codigoTx = require('./models/transacciones.model').codigo
  // Notificaciones in-app: conteo de alertas para el badge del sidebar
  res.locals.alertasResumen = null
  if (req.session.user && ['dueno', 'admin_contable'].includes(req.session.user.rol)) {
    try { res.locals.alertasResumen = require('./models/alertas.model').resumen() } catch (_) {}
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
app.use('/proveedores',   require('./routes/proveedores.routes'))
app.use('/compras',       require('./routes/compras.routes'))
app.use('/transacciones', require('./routes/transacciones.routes'))
app.use('/remitos',       require('./routes/remitos.routes'))
app.use('/usuarios',      require('./routes/usuarios.routes'))
app.use('/empleados',     require('./routes/empleados.routes'))
app.use('/choferes',      require('./routes/choferes.routes'))
app.use('/flota',         require('./routes/flota.routes'))
app.use('/alertas',       require('./routes/alertas.routes'))
app.use('/operaciones',   require('./routes/operaciones.routes'))
app.use('/hoja-de-ruta',  require('./routes/hojaRuta.routes'))
app.use('/circuitos',     require('./routes/circuitos.routes'))
app.use('/zonas',         require('./routes/zonas.routes'))

// ── Placeholders (módulos futuros) ───────────────────────────────
const placeholder = (titulo, icono, sprint) => (req, res) =>
  res.render('pages/placeholder', { titulo, icono, sprint })

app.get('/dashboard',   auth, roles('dueno'), require('./controllers/dashboard.controller').index)
app.get('/cobranzas',   auth, roles('admin_contable','dueno'), (req, res) => res.redirect('/clientes/cuentas'))
app.get('/facturacion', auth, roles('admin_contable','dueno'), placeholder('Facturación', '🧾', 6))

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
