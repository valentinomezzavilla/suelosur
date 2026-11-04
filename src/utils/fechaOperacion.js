'use strict'
// ═══════════════════════════════════════════════════════════════════
// Fecha de una operación: a qué día (y por lo tanto a qué mes) pertenece.
// Regla ÚNICA para todo el sistema — Cuenta corriente, Liquidaciones, Libro de ventas:
//
//  · Venta (cantera o con viaje, tipo_op 'M'): la FECHA DE COMPRA (fecha_emision),
//    el día en que el cliente hizo el pedido. La fecha de envío (fecha_entrega_planificada)
//    se muestra, pero no cambia el mes de la venta.
//  · Alquiler (contenedor / maquinaria): el día en que empieza (fecha_entrega_planificada);
//    si falta, el de emisión.
//
// Antes cada módulo usaba una regla distinta para las ventas con viaje (la cuenta corriente
// la fecha de carga y la Liquidación la de entrega), y una misma venta podía caer en meses
// distintos según dónde se mirara.
// ═══════════════════════════════════════════════════════════════════

// Expresión SQL 'YYYY-MM-DD' sobre op_encabezado (alias `a`, por defecto `op`)
function sqlFechaOperacion(a = 'op') {
  return `LEFT(CASE WHEN ${a}.tipo_op = 'M' THEN ${a}.fecha_emision ELSE COALESCE(NULLIF(${a}.fecha_entrega_planificada, ''), ${a}.fecha_emision) END, 10)`
}

const SQL_FECHA_OPERACION = sqlFechaOperacion('op')

// Lo mismo en JS, sobre una fila con tipo_op, fecha_emision y fecha_entrega_planificada
function fechaDeOperacion(op) {
  if (!op) return ''
  const f = op.tipo_op === 'M' ? op.fecha_emision : (op.fecha_entrega_planificada || op.fecha_emision)
  return String(f || '').slice(0, 10)
}

module.exports = { sqlFechaOperacion, SQL_FECHA_OPERACION, fechaDeOperacion }
