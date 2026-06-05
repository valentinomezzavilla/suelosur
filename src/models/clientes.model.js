'use strict'
const crypto = require('crypto')
const db = require('../config/db')

const ClientesModel = {

  listar() {
    return db.prepare(`SELECT * FROM clientes WHERE activo = 1 ORDER BY nombre`).all()
  },

  obtener(id) {
    return db.prepare(`SELECT * FROM clientes WHERE id = ?`).get(id)
  },

  buscar({ id, dni, nombre, numero } = {}) {
    // numero explícito (entero secuencial visible al usuario)
    if (numero != null && numero !== '') {
      const n = Number(numero)
      if (Number.isFinite(n)) {
        return [db.prepare(`SELECT * FROM clientes WHERE numero = ?`).get(n)].filter(Boolean)
      }
    }
    // id puede venir como UUID (interno) o como número (input humano)
    if (id) {
      const sId = String(id).trim()
      if (/^\d+$/.test(sId)) {
        return [db.prepare(`SELECT * FROM clientes WHERE numero = ?`).get(Number(sId))].filter(Boolean)
      }
      return [db.prepare(`SELECT * FROM clientes WHERE id = ?`).get(sId)].filter(Boolean)
    }
    if (dni)    return db.prepare(`SELECT * FROM clientes WHERE dni = ?`).all(dni)
    if (nombre) return db.prepare(`
      SELECT * FROM clientes WHERE nombre LIKE ? OR apellido LIKE ? ORDER BY nombre
    `).all(`%${nombre}%`, `%${nombre}%`)
    return db.prepare(`SELECT * FROM clientes WHERE activo = 1 ORDER BY nombre`).all()
  },

  proximoNumero() {
    const r = db.prepare(`SELECT COALESCE(MAX(numero), 0) AS m FROM clientes`).get()
    return (r.m || 0) + 1
  },

  crear({ nombre, apellido, domicilio_ppal, zona, tel_whatsapp, telefono, email, dni, tipo_cliente, cuenta_corriente }) {
    const id = crypto.randomUUID()
    const numero = this.proximoNumero()
    db.prepare(`
      INSERT INTO clientes (id, numero, nombre, apellido, domicilio_ppal, zona, tel_whatsapp, telefono, email, dni, tipo_cliente, cuenta_corriente)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, numero, nombre, apellido || '', domicilio_ppal || null, zona || null,
           tel_whatsapp || null, telefono || null, email || null, dni || null,
           tipo_cliente || null, cuenta_corriente ? 1 : 0)
    return id
  },

  actualizar(id, datos) {
    const fields = []
    const values = []
    const map = { nombre:1, apellido:1, domicilio_ppal:1, zona:1, tel_whatsapp:1, telefono:1, email:1, dni:1, tipo_cliente:1 }
    for (const [k, v] of Object.entries(datos)) {
      if (map[k]) { fields.push(`${k} = ?`); values.push(v ?? null) }
    }
    if (datos.cuenta_corriente !== undefined) {
      fields.push('cuenta_corriente = ?')
      values.push(datos.cuenta_corriente === true || datos.cuenta_corriente === 'true' ? 1 : 0)
    }
    if (!fields.length) return
    values.push(id)
    db.prepare(`UPDATE clientes SET ${fields.join(', ')} WHERE id = ?`).run(...values)
  },

  toggleActivo(id) {
    db.prepare(`UPDATE clientes SET activo = NOT activo WHERE id = ?`).run(id)
  },

  habilitarCuenta(id) {
    db.prepare(`UPDATE clientes SET cuenta_corriente = 1 WHERE id = ?`).run(id)
  },

  agregarMovimiento(id, { tipo, descripcion, monto }) {
    const movId = crypto.randomUUID()
    db.prepare(`INSERT INTO movimientos_cuenta (id, cliente_id, tipo, descripcion, monto) VALUES (?, ?, ?, ?, ?)`
    ).run(movId, id, tipo, descripcion, Number(monto))
    db.prepare(`UPDATE clientes SET saldo = saldo + ? WHERE id = ?`).run(Number(monto), id)
    return movId
  },

  movimientos(clienteId) {
    return db.prepare(`SELECT * FROM movimientos_cuenta WHERE cliente_id = ? ORDER BY created_at DESC`).all(clienteId)
  },

  nombreCompleto(c) {
    if (!c) return ''
    return `${c.nombre} ${c.apellido || ''}`.trim()
  },
}

module.exports = ClientesModel
