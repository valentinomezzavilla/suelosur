'use strict'

// Tamaño de página estándar para todas las tablas del sistema
const LIMITE_TABLA = 20

// Resuelve sort/dir con whitelist (evita SQL injection en ORDER BY)
function resolverSort({ sort, dir }, sortMap, defaultSort, defaultDir = 'DESC') {
  const col = sortMap[sort] || sortMap[defaultSort] || Object.values(sortMap)[0]
  const direction = String(dir || '').toUpperCase() === 'ASC' ? 'ASC' : (String(dir || '').toUpperCase() === 'DESC' ? 'DESC' : defaultDir)
  return { col, direction, key: sort || defaultSort, dir: direction }
}

// Resuelve número de página
function resolverPagina(page, totalRegistros, limit = LIMITE_TABLA) {
  let p = parseInt(page) || 1
  if (p < 1) p = 1
  const totalPaginas = Math.max(1, Math.ceil((totalRegistros || 0) / limit))
  if (p > totalPaginas) p = totalPaginas
  const offset = (p - 1) * limit
  return { page: p, totalPaginas, offset, limit }
}

module.exports = { LIMITE_TABLA, resolverSort, resolverPagina }
