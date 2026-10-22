'use strict'
// IVA de las operaciones "para facturar": el precio que se carga es el NETO y al cliente se
// le cobra neto + IVA. op_encabezado.iva_alicuota guarda la alícuota sumada (21) o NULL si
// no se sumó nada (no es para facturar, o se marcó antes de este criterio: ahí el precio
// cargado era el final, con IVA incluido).

const ALICUOTA_FACTURAR = 21

const redondear = (n) => Math.round((Number(n) || 0) * 100) / 100

const ivaDe   = (neto, alicuota) => Number(alicuota) ? redondear(Number(neto) * Number(alicuota) / 100) : 0
const conIva  = (neto, alicuota) => redondear(Number(neto) + ivaDe(neto, alicuota))
// Inversa de conIva: el neto de un importe que ya trae el IVA sumado
const sinIva  = (total, alicuota) => Number(alicuota) ? redondear(Number(total) / (1 + Number(alicuota) / 100)) : redondear(total)
const etiqueta = (alicuota) => `IVA ${String(Number(alicuota)).replace('.', ',')}%`

// Factor para multiplicar un neto en SQL (1 si la operación no lleva IVA sumado)
const sqlFactorIva = (alias = 'op') => `(1 + COALESCE(${alias}.iva_alicuota, 0) / 100.0)`

module.exports = { ALICUOTA_FACTURAR, ivaDe, conIva, sinIva, etiqueta, sqlFactorIva }
