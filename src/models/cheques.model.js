'use strict'
// ═══════════════════════════════════════════════════════════════════
// cheques.model.js — Cartera de cheques recibidos (de clientes) y
// emitidos (a proveedores / empleados). Guarda todos los datos del
// cheque y su estado (habilitado / deshabilitado / en_espera).
// ═══════════════════════════════════════════════════════════════════
const { query } = require('../config/db')

const ESTADOS = ['habilitado', 'deshabilitado', 'en_espera']
const TIPOS_CARTERA = ['recibido', 'emitido']

const CAMPOS = {
  tipo_cartera: (v) => TIPOS_CARTERA.includes(v) ? v : 'recibido',
  numero: (v) => v || null,
  monto: (v) => parseFloat(v) || 0,
  tipo: (v) => (v === 'echeq' ? 'echeq' : 'fisico'),
  banco: (v) => v || null,
  a_nombre_de: (v) => v || null,
  fecha_pago: (v) => v || null,
  fecha_vencimiento: (v) => v || null,
  estado: (v) => ESTADOS.includes(v) ? v : 'en_espera',
  id_cliente: (v) => v || null,
  id_proveedor: (v) => v || null,
  id_empleado: (v) => v || null,
  descripcion: (v) => v || '',
}

const ChequesModel = {

  ESTADOS, TIPOS_CARTERA,

  async crear(datos) {
    const d = {}
    for (const k in CAMPOS) d[k] = CAMPOS[k](datos[k])
    // Un cheque recibido no se emite a proveedor/empleado, y viceversa: limpiamos vínculos cruzados.
    if (d.tipo_cartera === 'recibido') { d.id_proveedor = null; d.id_empleado = null }
    else { d.id_cliente = null }
    const { rows } = await query(`
      INSERT INTO cheques (tipo_cartera, numero, monto, tipo, banco, a_nombre_de, fecha_pago, fecha_vencimiento, estado, id_cliente, id_proveedor, id_empleado, descripcion, id_usuario)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id
    `, [d.tipo_cartera, d.numero, d.monto, d.tipo, d.banco, d.a_nombre_de, d.fecha_pago, d.fecha_vencimiento,
        d.estado, d.id_cliente, d.id_proveedor, d.id_empleado, d.descripcion, datos.id_usuario || null])
    return rows[0].id
  },

  async actualizar(id, datos) {
    const d = {}
    for (const k in CAMPOS) d[k] = CAMPOS[k](datos[k])
    if (d.tipo_cartera === 'recibido') { d.id_proveedor = null; d.id_empleado = null }
    else { d.id_cliente = null }
    await query(`
      UPDATE cheques SET tipo_cartera=?, numero=?, monto=?, tipo=?, banco=?, a_nombre_de=?, fecha_pago=?,
             fecha_vencimiento=?, estado=?, id_cliente=?, id_proveedor=?, id_empleado=?, descripcion=?
      WHERE id=?
    `, [d.tipo_cartera, d.numero, d.monto, d.tipo, d.banco, d.a_nombre_de, d.fecha_pago, d.fecha_vencimiento,
        d.estado, d.id_cliente, d.id_proveedor, d.id_empleado, d.descripcion, id])
  },

  async cambiarEstado(id, estado) {
    if (!ESTADOS.includes(estado)) throw new Error('Estado inválido.')
    await query(`UPDATE cheques SET estado = ? WHERE id = ?`, [estado, id])
  },

  // Guarda (o limpia) el id del movimiento de cuenta corriente que generó el cheque.
  async setMovCuenta(id, movId) {
    await query(`UPDATE cheques SET id_mov_cuenta = ? WHERE id = ?`, [movId || null, id])
  },

  async obtener(id) {
    return (await query(`SELECT * FROM cheques WHERE id = ?`, [id])).rows[0]
  },

  async listar({ tipo_cartera, estado, tipo, q } = {}) {
    const wheres = []
    const params = []
    if (tipo_cartera) { wheres.push('c.tipo_cartera = ?'); params.push(tipo_cartera) }
    if (estado)       { wheres.push('c.estado = ?');       params.push(estado) }
    if (tipo)         { wheres.push('c.tipo = ?');         params.push(tipo) }
    if (q && String(q).trim()) {
      const like = `%${String(q).trim()}%`
      wheres.push(`(COALESCE(c.numero,'') ILIKE ? OR COALESCE(c.a_nombre_de,'') ILIKE ? OR COALESCE(c.banco,'') ILIKE ?)`)
      params.push(like, like, like)
    }
    const where = wheres.length ? 'WHERE ' + wheres.join(' AND ') : ''
    return (await query(`
      SELECT c.*,
             cli.nombre AS cliente_nombre,
             p.nombre   AS proveedor_nombre,
             NULLIF(TRIM(COALESCE(e.nombre,'') || ' ' || COALESCE(e.apellido,'')), '') AS empleado_nombre
      FROM cheques c
      LEFT JOIN clientes cli    ON cli.id = c.id_cliente
      LEFT JOIN proveedores p   ON p.id   = c.id_proveedor
      LEFT JOIN empleados e     ON e.id   = c.id_empleado
      ${where}
      ORDER BY COALESCE(c.fecha_vencimiento, c.fecha_pago, c.created_at) ASC, c.id DESC
    `, params)).rows
  },

  // Totales por tipo de cartera y estado (para las tarjetas de la cartera).
  async resumen() {
    const rows = (await query(`SELECT tipo_cartera, estado, COUNT(*) AS c, COALESCE(SUM(monto),0) AS s FROM cheques GROUP BY tipo_cartera, estado`)).rows
    const r = {
      recibido: { total: 0, en_espera: 0, habilitado: 0, deshabilitado: 0 },
      emitido:  { total: 0, en_espera: 0, habilitado: 0, deshabilitado: 0 },
    }
    rows.forEach(x => {
      if (!r[x.tipo_cartera]) return
      r[x.tipo_cartera][x.estado] = Number(x.s)
      r[x.tipo_cartera].total += Number(x.s)
    })
    return r
  },

  async eliminar(id) {
    await query(`DELETE FROM cheques WHERE id = ?`, [id])
  },
}

module.exports = ChequesModel
