'use strict'
// Arnés de pruebas contra la base de datos.
//
// No hay base de desarrollo: el .env apunta a PRODUCCIÓN. Por eso cada archivo de prueba
// trabaja dentro de UNA transacción que se deshace al final (ROLLBACK): nada de lo que
// hacen las pruebas queda guardado. Cada sentencia corre en su propio SAVEPOINT, así un
// error esperado (ej. "contenedor ocupado") no aborta la transacción entera.
//
// IMPORTANTE: requerir este archivo ANTES que cualquier modelo: los modelos copian `query`
// y `transaction` de src/config/db en el momento en que se cargan.
const path = require('path')
process.env.TZ = process.env.TZ || 'America/Argentina/Cordoba'
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') })
const db = require('../../src/config/db')

let cliente = null
let contador = 0
let secuenciaInicial = null

const aPostgres = (sql) => { let i = 0; return String(sql).replace(/\?/g, () => `$${++i}`) }

async function enSavepoint(fn) {
  const sp = `sp_${++contador}`
  await cliente.query(`SAVEPOINT ${sp}`)
  try {
    const r = await fn()
    await cliente.query(`RELEASE SAVEPOINT ${sp}`)
    return r
  } catch (e) {
    await cliente.query(`ROLLBACK TO SAVEPOINT ${sp}`)
    throw e
  }
}

const correr = (sql, params = []) => enSavepoint(() => cliente.query(sql, params))

// Mientras dura la prueba, todo el código de la app pasa por la transacción de prueba.
db.query = (sql, params) => correr(aPostgres(sql), params)
db.pool.query = (sql, params) => correr(sql, params)
db.transaction = (fn) => enSavepoint(() => fn((sql, params) => correr(aPostgres(sql), params)))

async function abrir() {
  cliente = await db.pool.connect()
  // Cualquier otra conexión escribiría FUERA de la transacción de prueba (en producción).
  db.pool.connect = async () => { throw new Error('Prueba: el código intentó abrir otra conexión a la base') }
  await cliente.query('BEGIN')
  // nextval() no se deshace con ROLLBACK: se guarda la secuencia de N° de OP para
  // devolverla al final y no dejar huecos en la numeración real.
  secuenciaInicial = (await cliente.query(`SELECT last_value FROM op_nro_seq`)).rows[0]?.last_value ?? null
  // Si la migración de grupos todavía no está desplegada, se aplica dentro de la prueba
  // (y se deshace con el ROLLBACK). Mientras tanto bloquea op_encabezado en producción:
  // por eso la Tarea 1 se despliega antes de seguir con el resto.
  const hayGrupos = (await cliente.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name = 'op_encabezado' AND column_name = 'id_grupo'`)).rowCount
  if (!hayGrupos && typeof db.migrarGruposAlquiler === 'function') await db.migrarGruposAlquiler()
  // Lo mismo con la marca de precio asignado: sin desplegar, se aplica dentro de la prueba.
  const hayPrecioAsignado = (await cliente.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name = 'op_detalle_contenedor' AND column_name = 'precio_asignado_en'`)).rowCount
  if (!hayPrecioAsignado && typeof db.migrarAsignacionPrecio === 'function') await db.migrarAsignacionPrecio()
}

async function cerrar() {
  if (!cliente) return
  try {
    if (secuenciaInicial != null) await cliente.query(`SELECT setval('op_nro_seq', $1)`, [secuenciaInicial])
  } finally {
    await cliente.query('ROLLBACK')
    cliente.release()
    cliente = null
    await db.pool.end()
  }
}

module.exports = { abrir, cerrar, q: (sql, params) => db.query(sql, params) }
