'use strict'

// Paginación en memoria — uniforme para los listados del sistema.
// Devuelve el sub-conjunto de la página actual + metadatos para la vista.
module.exports = function paginar(items, page = 1, limit = 15) {
  const lista        = Array.isArray(items) ? items : []
  const total        = lista.length
  const totalPaginas = Math.max(1, Math.ceil(total / limit))
  const pagina       = Math.min(Math.max(1, parseInt(page, 10) || 1), totalPaginas)
  const offset       = (pagina - 1) * limit
  return {
    items: lista.slice(offset, offset + limit),
    total,
    page: pagina,
    limit,
    totalPaginas,
  }
}
