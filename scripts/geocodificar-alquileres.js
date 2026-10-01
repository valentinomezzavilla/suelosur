'use strict'
// Backfill del mapa de contenedores: geocodifica (Nominatim) los alquileres que todavía
// no tienen coordenadas. Respeta 1 request/s (la cola del servicio de geocodificación).
//
// Uso:
//   npm run geocodificar:alquileres                 → activos y programados nunca intentados
//   npm run geocodificar:alquileres -- --reintentar → incluye los que fallaron (sin resultado / ambigua / error)
//   npm run geocodificar:alquileres -- --todos      → incluye también los ya finalizados
//   npm run geocodificar:alquileres -- --dry-run    → solo lista, no consulta ni guarda nada

const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '..', '.env') })
const { pool, query } = require('../src/config/db')
const AlquileresModel = require('../src/models/alquileres.model')
const { armarConsulta } = require('../src/services/geocoding.service')

const args = new Set(process.argv.slice(2))
const REINTENTAR = args.has('--reintentar')
const TODOS      = args.has('--todos')
const DRY_RUN    = args.has('--dry-run')

async function main() {
  // Por si el script corre antes de que la app haya arrancado con la migración (initDB).
  for (const col of ['domicilio_lat DOUBLE PRECISION', 'domicilio_lng DOUBLE PRECISION', 'geo_estado TEXT', 'geo_actualizado_en TEXT']) {
    await query(`ALTER TABLE op_detalle_contenedor ADD COLUMN IF NOT EXISTS ${col}`)
  }
  await query(`ALTER TABLE op_detalle_contenedor ALTER COLUMN domicilio_lat TYPE DOUBLE PRECISION`)
  await query(`ALTER TABLE op_detalle_contenedor ALTER COLUMN domicilio_lng TYPE DOUBLE PRECISION`)

  const estados = REINTENTAR ? `oc.geo_estado IS NULL OR oc.geo_estado IN ('sin_resultado','ambigua','error')` : `oc.geo_estado IS NULL`
  // Activo = entregado y el contenedor sigue en el domicilio; programado = pendiente/despachado.
  const soloVigentes = TODOS ? '' : `AND (op.estado IN ('pendiente','despachado') OR um.estado_paso IN ('en_alquiler','pendiente_retiro'))`
  const filas = (await query(`
    SELECT op.id, op.nro_op, op.estado, oc.domicilio_calle, oc.domicilio_numero, oc.geo_estado
    FROM op_encabezado op
    JOIN op_detalle_contenedor oc ON oc.id_orden_pedido = op.id
    LEFT JOIN (
      SELECT DISTINCT ON (id_contenedor) id_contenedor, id_op_contenedor, estado_paso
      FROM movimiento_contenedor ORDER BY id_contenedor, fecha_movimiento DESC, id DESC
    ) um ON um.id_contenedor = oc.id_contenedor AND um.id_op_contenedor = oc.id
    WHERE op.tipo_op = 'C' AND op.estado <> 'anulado'
      AND (oc.domicilio_lat IS NULL OR oc.domicilio_lng IS NULL)
      AND (${estados})
      ${soloVigentes}
    ORDER BY op.id
  `)).rows

  console.log(`${filas.length} alquiler(es) para geocodificar${DRY_RUN ? ' (dry-run)' : ''}.`)
  const resumen = {}
  for (const f of filas) {
    const op = 'OP-' + String(f.nro_op).padStart(4, '0')
    const consulta = armarConsulta({ calle: f.domicilio_calle, numero: f.domicilio_numero }) || '(sin calle)'
    if (DRY_RUN) { console.log(`  ${op}  ${consulta}`); continue }
    const geo = await AlquileresModel.ubicar(f.id)
    const estado = geo?.estado || 'error'
    resumen[estado] = (resumen[estado] || 0) + 1
    console.log(`  ${op}  ${consulta}  →  ${estado}${geo?.lat != null ? ` (${geo.lat.toFixed(5)}, ${geo.lng.toFixed(5)})` : ''}`)
  }
  if (!DRY_RUN) console.log('Resumen:', resumen)
}

main()
  .catch(e => { console.error(e); process.exitCode = 1 })
  .finally(() => pool.end())
