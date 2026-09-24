'use strict'

// Siguiente número de operación (OP-0001…). Sale de la secuencia op_nro_seq, que solo
// avanza: al borrar una operación su número NO se vuelve a usar (antes era
// MAX(nro_op)+1 y el número de la última operación borrada se repetía).
// El GREATEST con MAX+1 cubre el caso de que otra versión del sistema haya numerado
// por fuera de la secuencia: nunca devuelve un número vigente y la deja al día.
const SQL_SIGUIENTE_NRO_OP = `setval('op_nro_seq', GREATEST(nextval('op_nro_seq'),
  (SELECT COALESCE(MAX(nro_op), 0) + 1 FROM op_encabezado)))::int`

module.exports = { SQL_SIGUIENTE_NRO_OP }
