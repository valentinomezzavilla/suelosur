require('dotenv').config()
const { initDB } = require('./src/config/db')
const app = require('./src/app')

const PORT = process.env.PORT || 3000

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
  })
  .catch(err => {
    console.error('❌ Error inicializando la base de datos:', err)
    process.exit(1)
  })
