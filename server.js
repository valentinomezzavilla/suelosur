require('dotenv').config()
const { initDB } = require('./src/config/db')
const app = require('./src/app')

const PORT = process.env.PORT || 3000

initDB()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`✅ Suelosur corriendo en http://localhost:${PORT}`)
    })
  })
  .catch(err => {
    console.error('❌ Error inicializando la base de datos:', err)
    process.exit(1)
  })
