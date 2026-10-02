'use strict'
// Agrupa alquileres de contenedor ya cargados por separado en un solo alquiler agrupado.
//
// Uso:
//   npm run agrupar:alquileres -- 251 252                → simula (no escribe nada)
//   npm run agrupar:alquileres -- 251 252 --confirmar    → agrupa (cobro por contenedor)
//   npm run agrupar:alquileres -- 251 252 --cobro=alquiler --confirmar
//
// Escribe en la base del .env (producción): correrlo con --confirmar solo con OK.

const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '..', '.env') })
const { pool } = require('../src/config/db')
const AlquileresModel = require('../src/models/alquileres.model')

const args = process.argv.slice(2)
const nros = args.filter(a => /^\d+$/.test(a)).map(Number)
const cobro = (args.find(a => a.startsWith('--cobro=')) || '--cobro=contenedor').split('=')[1]
const confirmar = args.includes('--confirmar')

async function main() {
  if (!['contenedor', 'alquiler'].includes(cobro)) throw new Error('--cobro tiene que ser "contenedor" o "alquiler".')
  const r = await AlquileresModel.agruparExistentes(nros, cobro, { simular: !confirmar })
  const nombre = (o) => 'OP-' + String(o.nro_op).padStart(4, '0')
  // Detalle de cada OP para revisarlo antes de confirmar
  for (const o of r.ops) {
    console.log(`  ${nombre(o)} · contenedor N° ${o.numero_contenedor ?? '—'} · ${o.estado}${o.retirado ? ' (ya retirado)' : ''}`
      + ` · pago: ${o.metodo_pago || 'sin especificar'} · ${o.domicilio_entrega || 'sin dirección'} · remito ${o.nro_remito ?? '—'}`)
  }
  const lista = r.ops.map(nombre).join(', ')
  console.log(confirmar
    ? `Agrupadas ${lista} (grupo ${r.id_grupo}, cobro por ${cobro}).`
    : `Simulación OK: se agruparían ${lista} con cobro por ${cobro}. Repetir con --confirmar para aplicarlo.`)
}

main()
  .catch(e => { console.error('No se agrupó nada:', e.message); process.exitCode = 1 })
  .finally(() => pool.end())
