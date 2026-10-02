'use strict'
// Datos de prueba: se crean dentro de la transacción de la prueba y desaparecen con el
// ROLLBACK. Los N° de contenedor de prueba arrancan en 90001 para no chocar con los reales.
const { q } = require('./db')

let proximoNumero = 90001

// Contenedores nuevos, disponibles (último movimiento 'disponible').
async function crearContenedores(n) {
  const ids = []
  for (let i = 0; i < n; i++) {
    const { id } = (await q(`INSERT INTO contenedores (numero_contenedor) VALUES (?) RETURNING id`, [proximoNumero++])).rows[0]
    await q(`INSERT INTO movimiento_contenedor (id_contenedor, estado_paso, observaciones) VALUES (?, 'disponible', 'Prueba')`, [id])
    ids.push(id)
  }
  return ids
}

async function crearCliente({ cuentaCorriente = false } = {}) {
  return (await q(
    `INSERT INTO clientes (nombre, apellido, cuenta_corriente, activo, saldo) VALUES ('PRUEBA', 'GRUPOS', ?, 1, 0) RETURNING id`,
    [cuentaCorriente ? 1 : 0])).rows[0].id
}

async function idAdministrativo() {
  return (await q(`SELECT id FROM users ORDER BY id LIMIT 1`)).rows[0].id
}

// Datos compartidos de un alta (dirección, método de pago, fechas, etc.).
function datosComunes({ id_cliente, id_administrativo, metodo_pago = 'efectivo', fecha_inicio = '2026-10-05' }) {
  return {
    id_cliente, id_administrativo,
    domicilio_entrega: 'San Lorenzo 501', domicilio_calle: 'San Lorenzo', domicilio_numero: '501',
    zona_entrega: '', metodo_pago, observaciones: 'PRUEBA', obra: null,
    fecha_inicio, fecha_entrega_planificada: fecha_inicio,
  }
}

module.exports = { crearContenedores, crearCliente, idAdministrativo, datosComunes }
