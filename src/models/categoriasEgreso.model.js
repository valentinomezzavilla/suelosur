'use strict'
// ═══════════════════════════════════════════════════════════════════
// categoriasEgreso.model.js — Categorías del libro de compras / pagos.
// 'material' y 'sueldo' son categorías del sistema (mueven stock / generan
// recibo de sueldo, ver compras.controller.js) y no se pueden editar ni
// borrar. El resto se administra libremente: cada categoría declara qué
// campos fijos usa (proveedor, producto, vehiculo, empleado, fletero,
// periodo — los mismos que ya existen en el formulario) y además puede
// definir campos propios (texto / número / fecha / lista), con su nombre
// y tipo. Los valores de los campos propios se guardan en egresos.datos_extra.
// ═══════════════════════════════════════════════════════════════════
const { query } = require('../config/db')

const CAMPOS_DISPONIBLES = [
  { clave: 'proveedor', etiqueta: 'Proveedor' },
  { clave: 'producto',  etiqueta: 'Producto' },
  { clave: 'vehiculo',  etiqueta: 'Vehículo' },
  { clave: 'empleado',  etiqueta: 'Empleado' },
  { clave: 'fletero',   etiqueta: 'Fletero' },
  { clave: 'periodo',   etiqueta: 'Período' },
]

const BADGES_DISPONIBLES = ['badge-activo', 'badge-en-transito', 'badge-alerta', 'badge-pendiente']

const TIPOS_CAMPO_DISPONIBLES = [
  { clave: 'texto',  etiqueta: 'Texto' },
  { clave: 'numero', etiqueta: 'Número' },
  { clave: 'fecha',  etiqueta: 'Fecha' },
  { clave: 'lista',  etiqueta: 'Lista desplegable' },
]

function normalizarClave(s) {
  return (s || '').toString().trim().toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
}

// Los campos propios de una categoría se guardan con clave propia (prefijo 'c_' para
// que nunca choquen con los campos fijos: proveedor, producto, vehiculo, etc.).
function normalizarCamposCustom(lista) {
  const usadas = new Set()
  return (Array.isArray(lista) ? lista : [])
    .map(f => ({
      etiqueta: (f?.etiqueta || '').toString().trim(),
      tipo: TIPOS_CAMPO_DISPONIBLES.some(t => t.clave === f?.tipo) ? f.tipo : 'texto',
      opciones: (f?.opciones || '').toString().split(',').map(o => o.trim()).filter(Boolean),
    }))
    .filter(f => f.etiqueta)
    .map(f => {
      let base = 'c_' + normalizarClave(f.etiqueta)
      let clave = base, i = 2
      while (usadas.has(clave)) { clave = `${base}_${i++}` }
      usadas.add(clave)
      return { clave, etiqueta: f.etiqueta, tipo: f.tipo, opciones: f.tipo === 'lista' ? f.opciones : [] }
    })
}

function mapRow(r) {
  if (!r) return r
  let campos = []
  let camposCustom = []
  try { campos = JSON.parse(r.campos || '[]') } catch { campos = [] }
  try { camposCustom = JSON.parse(r.campos_custom || '[]') } catch { camposCustom = [] }
  return { ...r, campos, camposCustom, sistema: !!r.sistema, activo: !!r.activo }
}

const CategoriasEgresoModel = {
  CAMPOS_DISPONIBLES,
  BADGES_DISPONIBLES,
  TIPOS_CAMPO_DISPONIBLES,

  async listar({ soloActivas } = {}) {
    const where = soloActivas ? 'WHERE activo = 1' : ''
    const rows = (await query(`SELECT * FROM categorias_egreso ${where} ORDER BY orden, etiqueta`)).rows
    return rows.map(mapRow)
  },

  async obtener(id) {
    return mapRow((await query(`SELECT * FROM categorias_egreso WHERE id = ?`, [id])).rows[0])
  },

  async obtenerPorClave(clave) {
    return mapRow((await query(`SELECT * FROM categorias_egreso WHERE clave = ?`, [clave])).rows[0])
  },

  async crear({ etiqueta, campos, camposCustom, badge }) {
    if (!etiqueta || !etiqueta.trim()) throw new Error('El nombre de la categoría es obligatorio.')
    const clave = normalizarClave(etiqueta)
    if (!clave) throw new Error('El nombre de la categoría es obligatorio.')
    if (await this.obtenerPorClave(clave)) throw new Error('Ya existe una categoría con ese nombre.')
    const camposValidos = (Array.isArray(campos) ? campos : [campos]).filter(c => CAMPOS_DISPONIBLES.some(d => d.clave === c))
    const camposCustomValidos = normalizarCamposCustom(camposCustom)
    const badgeValido = BADGES_DISPONIBLES.includes(badge) ? badge : 'badge-pendiente'
    const { rows } = (await query(`
      SELECT COALESCE(MAX(orden), 0) + 1 AS siguiente FROM categorias_egreso
    `))
    const orden = rows[0].siguiente
    const { rows: ins } = await query(`
      INSERT INTO categorias_egreso (clave, etiqueta, campos, campos_custom, badge, sistema, activo, orden)
      VALUES (?, ?, ?, ?, ?, 0, 1, ?) RETURNING id
    `, [clave, etiqueta.trim(), JSON.stringify(camposValidos), JSON.stringify(camposCustomValidos), badgeValido, orden])
    return ins[0].id
  },

  async actualizar(id, { etiqueta, campos, camposCustom, badge, activo }) {
    const actual = await this.obtener(id)
    if (!actual) throw new Error('Categoría no encontrada.')
    if (actual.sistema) throw new Error('Esta es una categoría del sistema y no se puede editar.')
    if (!etiqueta || !etiqueta.trim()) throw new Error('El nombre de la categoría es obligatorio.')
    const camposValidos = (Array.isArray(campos) ? campos : (campos ? [campos] : [])).filter(c => CAMPOS_DISPONIBLES.some(d => d.clave === c))
    const camposCustomValidos = normalizarCamposCustom(camposCustom)
    const badgeValido = BADGES_DISPONIBLES.includes(badge) ? badge : actual.badge
    await query(`
      UPDATE categorias_egreso SET etiqueta = ?, campos = ?, campos_custom = ?, badge = ?, activo = ? WHERE id = ?
    `, [etiqueta.trim(), JSON.stringify(camposValidos), JSON.stringify(camposCustomValidos), badgeValido, activo ? 1 : 0, id])
  },

  async toggleActivo(id) {
    const actual = await this.obtener(id)
    if (!actual) throw new Error('Categoría no encontrada.')
    if (actual.sistema) throw new Error('Esta es una categoría del sistema y no se puede desactivar.')
    await query(`UPDATE categorias_egreso SET activo = ? WHERE id = ?`, [actual.activo ? 0 : 1, id])
  },

  async eliminar(id) {
    const actual = await this.obtener(id)
    if (!actual) return
    if (actual.sistema) throw new Error('Esta es una categoría del sistema y no se puede eliminar.')
    const { rows } = await query(`SELECT COUNT(*) AS c FROM egresos WHERE categoria = ?`, [actual.clave])
    if (Number(rows[0].c) > 0) throw new Error('No se puede eliminar: hay compras / pagos registrados con esta categoría. Podés desactivarla.')
    await query(`DELETE FROM categorias_egreso WHERE id = ?`, [id])
  },
}

module.exports = CategoriasEgresoModel
