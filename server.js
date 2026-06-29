require('dotenv').config()
const { initDB, limpiarRastreoViejo } = require('./src/config/db')
const app = require('./src/app')

const PORT = process.env.PORT || 3000
const DIA_MS = 24 * 60 * 60 * 1000

// Atrapar excepciones que escapan a try/catch — para no morir silencioso en producción
process.on('uncaughtException', (err) => {
  console.error('💥 uncaughtException:', err)
})
process.on('unhandledRejection', (reason) => {
  console.error('💥 unhandledRejection:', reason)
})

initDB()
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`✅ Suelosur corriendo en puerto ${PORT}`)
    })
    // Limpieza del rastreo GPS: conserva la última semana. Corre al arrancar
    // (cubre los reinicios de Render) y luego cada 24 h mientras la app viva.
    limpiarRastreoViejo(7)
    setInterval(() => limpiarRastreoViejo(7), DIA_MS)
  })
  .catch(err => {
    console.error('❌ Error inicializando la base de datos:', err)
    process.exit(1)
  })
