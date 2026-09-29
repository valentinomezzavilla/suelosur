// Nombre completo del cliente (nombre + apellido) armado en SQL. Muchos clientes son
// razones sociales cargadas con nombre y apellido iguales ("FEHUSA" / "FEHUSA"), o
// personas con el apellido aparte: mostrar solo `nombre` deja el nombre cortado.
// Devuelve NULL si los dos están vacíos, para poder envolverlo en COALESCE(…, 'Particular').
const nombreClienteSQL = (alias) =>
  `NULLIF(TRIM(COALESCE(${alias}.nombre,'') || ' ' || COALESCE(${alias}.apellido,'')), '')`

module.exports = { nombreClienteSQL }
