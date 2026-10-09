'use strict'

// Contenedor vendido como producto (Venta en cantera / con viaje): se cobra POR UNIDAD
// — cantidad de contenedores × precio por unidad (precio cantera / viaje del producto) —
// y no mueve stock (se alquila y vuelve). Puede haber varios en la misma operación.
//
// Antes (hasta 2026-10) se cargaba de a uno con días y precio por día según rangos: esos
// renglones viejos tienen op_detalle_material.dias cargado y se siguen mostrando como
// "Contenedor (7 días)". Los nuevos llevan dias NULL.

const UNIDAD_CONTENEDOR = 'unid.'

// Condición SQL (sobre productos p y op_detalle_material d) de un renglón que mueve
// stock: ni contenedor, ni producto sin control de stock, ni renglón viejo con días.
const SQL_MUEVE_STOCK = `(d.dias IS NULL AND COALESCE(p.depende_stock, 1) = 1 AND COALESCE(p.es_contenedor, 0) = 0)`

// Para los SELECT sobre op_detalle_material d JOIN productos p: un renglón viejo de
// contenedor se muestra como "Contenedor (7 días)" y su unidad es el contenedor.
const SQL_DESCRIPCION_DETALLE = `(p.nombre || CASE WHEN d.dias IS NOT NULL THEN ' (' || d.dias || ' días)' ELSE '' END)`
const SQL_UNIDAD_DETALLE = `(CASE WHEN d.dias IS NOT NULL THEN 'unid.' ELSE p.unidad_medida END)`

module.exports = { UNIDAD_CONTENEDOR, SQL_MUEVE_STOCK, SQL_DESCRIPCION_DETALLE, SQL_UNIDAD_DETALLE }
