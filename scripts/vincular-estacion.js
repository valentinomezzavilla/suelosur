'use strict'
// Vincula a una estación de servicio lo que se cargó antes de que existieran las estaciones,
// con el nombre escrito a mano (ej. "SHELL" en el concepto) en lugar de elegirla:
//
//  · Egresos de categoría Combustible sin proveedor cuyo detalle menciona la estación: las
//    transferencias de clientes derivadas ("Destinado a tercero") y los pagos. Bajan la deuda.
//  · Cargas de combustible de la flota sin estación vinculada cuyo campo "estación" la
//    menciona. Suman deuda.
//
// La estación es el proveedor con ese nombre: si no existe se da de alta, y si existe pero no
// estaba marcado como estación, se marca. Solo completa vínculos vacíos (nunca cambia uno ya
// hecho) y no toca montos ni fechas.
//
// Uso:
//   npm run vincular:estacion -- --estacion=Shell              → simula: muestra lo que haría
//   npm run vincular:estacion -- --estacion=Shell --aplicar    → lo hace
// Opcionales: --texto=shel (lo que se busca; por defecto el nombre de la estación),
//             --id=12 (usar ese proveedor), --sin-cargas (solo egresos).
//
// Escribe en la base del entorno (producción): correr con --aplicar solo con OK.

const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '..', '.env') })
const { transaction, pool } = require('../src/config/db')

class Simulacion extends Error {}

// El proveedor de la estación: por id, por nombre exacto o por el único que contenga el texto
async function resolverEstacion(q, { estacion, id, texto }) {
  if (id) {
    const p = (await q(`SELECT * FROM proveedores WHERE id = ?`, [id])).rows[0]
    if (!p) throw new Error(`No existe el proveedor #${id}`)
    return { proveedor: p, nuevo: false }
  }
  const exacto = (await q(`SELECT * FROM proveedores WHERE LOWER(TRIM(nombre)) = LOWER(TRIM(?)) ORDER BY id`, [estacion])).rows
  if (exacto.length === 1) return { proveedor: exacto[0], nuevo: false }
  const parecidos = exacto.length ? exacto
    : (await q(`SELECT * FROM proveedores WHERE nombre ILIKE ? ORDER BY id`, [`%${texto}%`])).rows
  if (parecidos.length === 1) return { proveedor: parecidos[0], nuevo: false }
  if (parecidos.length > 1) {
    throw new Error(`Hay ${parecidos.length} proveedores que coinciden con "${texto}": `
      + parecidos.map(p => `#${p.id} ${p.nombre}`).join(', ') + '. Repetir con --id=N para elegir uno.')
  }
  const r = await q(`INSERT INTO proveedores (nombre, es_estacion) VALUES (?, 1) RETURNING *`, [estacion.trim()])
  return { proveedor: r.rows[0], nuevo: true }
}

async function saldo(q, idProveedor) {
  const r = (await q(`
    SELECT (SELECT COALESCE(SUM(costo_total), 0) FROM combustible WHERE id_proveedor = ?)
         + (SELECT COALESCE(SUM(monto_debito), 0) FROM cc_proveedores WHERE id_proveedor = ?) AS debe,
           (SELECT COALESCE(SUM(monto), 0) FROM egresos WHERE id_proveedor = ?)
         + (SELECT COALESCE(SUM(monto_credito), 0) FROM cc_proveedores WHERE id_proveedor = ?) AS haber
  `, [idProveedor, idProveedor, idProveedor, idProveedor])).rows[0]
  return { debe: Number(r.debe), haber: Number(r.haber), saldo: Number(r.debe) - Number(r.haber) }
}

// Hace todo en una transacción; sin `aplicar` la deshace al final (simulación)
async function vincular({ estacion, texto, id, conCargas = true, aplicar = false }) {
  texto = (texto || estacion || '').trim()
  if (!texto && !id) throw new Error('Falta --estacion=Nombre')
  let resultado
  try {
    await transaction(async (q) => {
      const { proveedor, nuevo } = await resolverEstacion(q, { estacion: estacion || texto, id, texto })
      const antes = nuevo ? { debe: 0, haber: 0, saldo: 0 } : await saldo(q, proveedor.id)
      const marcada = !nuevo && !Number(proveedor.es_estacion)
      if (marcada) await q(`UPDATE proveedores SET es_estacion = 1 WHERE id = ?`, [proveedor.id])

      const egresos = (await q(`
        UPDATE egresos SET id_proveedor = ?
        WHERE categoria = 'combustible' AND id_proveedor IS NULL AND descripcion ILIKE ?
        RETURNING id, fecha, monto, descripcion, origen`, [proveedor.id, `%${texto}%`])).rows
      const cargas = conCargas ? (await q(`
        UPDATE combustible SET id_proveedor = ?
        WHERE id_proveedor IS NULL AND estacion ILIKE ?
        RETURNING id, fecha, costo_total, estacion, id_vehiculo`, [proveedor.id, `%${texto}%`])).rows : []

      resultado = { proveedor, nuevo, marcada, egresos, cargas, antes, despues: await saldo(q, proveedor.id), aplicado: aplicar }
      if (!aplicar) throw new Simulacion()
    })
  } catch (e) {
    if (!(e instanceof Simulacion)) throw e
  }
  const orden = (a, b) => String(a.fecha).localeCompare(String(b.fecha)) || Number(a.id) - Number(b.id)
  resultado.egresos.sort(orden)
  resultado.cargas.sort(orden)
  return resultado
}

const plata = (n) => '$' + Number(n || 0).toLocaleString('es-AR', { maximumFractionDigits: 2 })
const saldoTxt = (s) => s < -0.005 ? `${plata(-s)} a favor` : plata(s)

async function main() {
  const args = process.argv.slice(2)
  const valor = (k) => (args.find(a => a.startsWith(`--${k}=`)) || '').split('=').slice(1).join('=').trim()
  const r = await vincular({
    estacion: valor('estacion'), texto: valor('texto'), id: valor('id') || null,
    conCargas: !args.includes('--sin-cargas'), aplicar: args.includes('--aplicar'),
  })
  const p = r.proveedor
  console.log(`\nEstación: #${p.id} ${p.nombre}${r.nuevo ? ' (se da de alta como estación)' : r.marcada ? ' (se marca como estación de servicio)' : ''}`)

  console.log(`\n=== Transferencias y pagos de combustible que se vinculan (${r.egresos.length}) — bajan la deuda ===`)
  r.egresos.forEach(e => console.log(`  egreso #${e.id}  ${String(e.fecha).slice(0, 10)}  ${plata(e.monto).padStart(14)}  `
    + `${e.origen === 'tercero' ? 'transf. de cliente' : 'pago'}  ${e.descripcion || ''}`))

  console.log(`\n=== Cargas de combustible de la flota que se vinculan (${r.cargas.length}) — suman deuda ===`)
  r.cargas.forEach(c => console.log(`  carga #${c.id}  ${String(c.fecha).slice(0, 10)}  ${plata(c.costo_total).padStart(14)}  `
    + `vehículo #${c.id_vehiculo}  estación "${c.estacion}"`))

  console.log(`\nDeuda con ${p.nombre}: antes ${saldoTxt(r.antes.saldo)} → después ${saldoTxt(r.despues.saldo)}`
    + `  (cargas/cargos ${plata(r.despues.debe)}, pagado/derivado ${plata(r.despues.haber)})`)
  console.log(r.aplicado ? '\nListo: cambios guardados.'
    : '\nSimulación: no se guardó nada. Repetir con --aplicar para hacerlo.')
}

module.exports = { vincular, main }

if (require.main === module) {
  main()
    .catch(e => { console.error('No se modificó nada:', e.message); process.exitCode = 1 })
    .finally(() => pool.end())
}
