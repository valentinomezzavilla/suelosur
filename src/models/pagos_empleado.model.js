'use strict'
// Pagos a empleados: sueldos, anticipos, viáticos, HE, bonif., descuentos, liquidaciones.
//
// Cada pago queda registrado en DOS lugares, vinculados entre sí:
//   · pagos_empleado → la pestaña "Pagos" de la ficha del chofer / empleado (y su recibo)
//   · egresos        → el libro de Compras / Pagos (salida de dinero, categoría "sueldo")
// Alta y baja tocan los dos a la vez, así nunca quedan desalineados.
const { query, transaction } = require('../config/db')
const { hoyISO } = require('../utils/fecha')

// Tipos que restan (descuento) — el resto suma al neto pagado.
const RESTAN = new Set(['descuento'])

const TIPO_LABEL = {
  sueldo: 'Sueldo', anticipo: 'Anticipo', viatico: 'Viático', horas_extra: 'Horas extra',
  bonificacion: 'Bonificación', descuento: 'Descuento', liquidacion: 'Liquidación',
}
// En estos tipos tiene sentido restar descuentos y sumar adiciones (recibo de sueldo)
const ADMITEN_AJUSTES = new Set(['sueldo', 'liquidacion'])

const redondear = (n) => Math.round((Number(n) || 0) * 100) / 100
const importe = (v) => Math.max(0, redondear(parseFloat(v)))

// Sueldo establecido en la ficha del empleado (el sueldo básico; si no, el salario general)
function sueldoEstablecido(emp) {
  return Number(emp && (emp.sueldo_basico || emp.salario)) || 0
}

const PagosEmpleadoModel = {

  TIPO_LABEL,
  sueldoEstablecido,

  // Pagos del empleado, con su origen: cargado a mano (ficha o Compras) o pagado por un
  // cliente con una transferencia a tercero (pagado_por = cliente, ref = OP / remito).
  async listar(id_empleado, { desde, hasta, tipo } = {}) {
    const wheres = ['p.id_empleado = ?']
    const params = [id_empleado]
    if (desde) { wheres.push('p.fecha >= ?'); params.push(desde) }
    if (hasta) { wheres.push('p.fecha <= ?'); params.push(hasta) }
    if (tipo)  { wheres.push('p.tipo = ?');  params.push(tipo) }
    return (await query(`
      SELECT p.*, e.origen AS egreso_origen, (e.origen = 'tercero') AS de_tercero,
             COALESCE(NULLIF(t.cliente, ''), NULLIF(TRIM(COALESCE(c.nombre, '') || ' ' || COALESCE(c.apellido, '')), '')) AS pagado_por,
             COALESCE(t.cliente_id, mc.cliente_id) AS pagado_por_id,
             op.nro_op AS pagado_nro_op, op.nro_remito AS pagado_nro_remito
      FROM pagos_empleado p
      LEFT JOIN LATERAL (
        SELECT * FROM egresos eg WHERE eg.id_pago_empleado = p.id OR eg.id = p.id_egreso ORDER BY eg.id LIMIT 1
      ) e ON TRUE
      LEFT JOIN transacciones t ON t.id = e.id_transaccion
      LEFT JOIN movimientos_cuenta mc ON mc.id = e.id_movimiento_cuenta
      LEFT JOIN clientes c ON c.id = mc.cliente_id
      LEFT JOIN op_encabezado op ON op.id = COALESCE(e.id_op_encabezado, t.id_op_encabezado)
      WHERE ${wheres.join(' AND ')}
      ORDER BY p.fecha DESC, p.created_at DESC
    `, params)).rows
  },

  // Sueldos de un mes ('AAAA-MM') de todos los empleados: { [id_empleado]: { sueldo, otros } }
  // (ver utils/sueldos: qué cuenta como sueldo y a qué mes pertenece cada pago)
  async delMes(mes) {
    const { totalesDelMes } = require('../utils/sueldos')
    const rows = (await query(`
      SELECT id_empleado, tipo, COALESCE(SUM(monto), 0)::float8 AS total
      FROM pagos_empleado
      WHERE COALESCE(NULLIF(periodo, ''), LEFT(fecha, 7)) = ?
      GROUP BY id_empleado, tipo
    `, [mes])).rows
    const porEmpleado = {}
    rows.forEach(r => (porEmpleado[r.id_empleado] ||= []).push(r))
    return Object.fromEntries(Object.entries(porEmpleado).map(([id, filas]) => [id, totalesDelMes(filas)]))
  },

  // Un pago con los datos del empleado que necesita el recibo
  async obtenerConEmpleado(id) {
    return (await query(`
      SELECT p.*, e.nombre, e.apellido, e.dni, e.cuil, e.legajo, e.cargo, e.categoria_laboral,
             e.sector, e.fecha_ingreso, e.tipo_contratacion,
             u.nombre AS usuario_nombre
      FROM pagos_empleado p
      JOIN empleados e ON e.id = p.id_empleado
      LEFT JOIN users u ON u.id = p.id_usuario
      WHERE p.id = ?
    `, [id])).rows[0]
  },

  // Registra el pago en la pestaña del empleado Y en el libro de compras / pagos.
  //   monto      = sueldo (o importe) BRUTO, antes de descuentos y adiciones
  //   descuentos = lo que se le descuenta · adiciones = bonificaciones que se le suman
  //   neto       = monto − descuentos + adiciones → lo que sale de caja y va al recibo
  async registrar({ id_empleado, tipo = 'sueldo', periodo, monto, descuentos, adiciones, fecha, descripcion, metodo_pago, id_usuario, origen = 'manual' }) {
    if (!TIPO_LABEL[tipo]) throw new Error('Tipo de pago inválido.')
    const emp = (await query(`SELECT id, nombre, apellido FROM empleados WHERE id = ?`, [id_empleado])).rows[0]
    if (!emp) throw new Error('El empleado no existe.')

    const base = importe(monto)
    if (base <= 0) throw new Error('Ingresá un monto mayor a cero.')
    const conAjustes = ADMITEN_AJUSTES.has(tipo)
    const desc = conAjustes ? importe(descuentos) : 0
    const adic = conAjustes ? importe(adiciones) : 0
    const neto = redondear(base - desc + adic)
    if (neto <= 0) throw new Error('Los descuentos no pueden ser iguales o mayores al sueldo más las adiciones.')

    const dia = fecha || hoyISO()
    const nombre = `${emp.nombre} ${emp.apellido || ''}`.trim()
    const detalle = (descripcion || '').trim()

    return await transaction(async (q) => {
      const { rows } = await q(`
        INSERT INTO pagos_empleado (id_empleado, tipo, periodo, monto, sueldo_base, descuentos, adiciones, fecha, descripcion, metodo_pago, id_usuario)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING id
      `, [id_empleado, tipo, periodo || null, neto, base, desc, adic, dia, detalle, metodo_pago || null, id_usuario || null])
      const id = rows[0].id

      // Un descuento suelto no es plata que sale de caja: solo queda en la ficha
      let id_egreso = null
      if (!RESTAN.has(tipo)) {
        const texto = [`${TIPO_LABEL[tipo]} — ${nombre}`, periodo ? `(${periodo})` : '', detalle ? `— ${detalle}` : ''].filter(Boolean).join(' ')
        const e = await q(`
          INSERT INTO egresos (fecha, categoria, descripcion, monto, metodo_pago, id_empleado, origen, id_usuario, id_pago_empleado)
          VALUES (?, 'sueldo', ?, ?, ?, ?, ?, ?, ?)
          RETURNING id
        `, [dia, texto, neto, metodo_pago || null, id_empleado, origen, id_usuario || null, id])
        id_egreso = e.rows[0].id
        await q(`UPDATE pagos_empleado SET id_egreso = ? WHERE id = ?`, [id_egreso, id])
      }
      return { id, id_egreso, neto, base, descuentos: desc, adiciones: adic }
    })
  },

  // Corrige un pago ya registrado (desde Compras / Pagos): mismas reglas que el alta, y el
  // egreso vinculado se actualiza igual (monto neto, fecha, método, empleado y texto). El
  // tipo no cambia. El recibo se arma siempre desde el pago, así que sale corregido.
  async actualizar(id, { id_empleado, periodo, monto, descuentos, adiciones, fecha, descripcion, metodo_pago }) {
    const actual = (await query(`SELECT * FROM pagos_empleado WHERE id = ?`, [id])).rows[0]
    if (!actual) throw new Error('El pago no existe.')
    const emp = (await query(`SELECT id, nombre, apellido FROM empleados WHERE id = ?`, [id_empleado])).rows[0]
    if (!emp) throw new Error('El empleado no existe.')
    const tipo = actual.tipo
    const base = importe(monto)
    if (base <= 0) throw new Error('Ingresá un monto mayor a cero.')
    const conAjustes = ADMITEN_AJUSTES.has(tipo)
    const desc = conAjustes ? importe(descuentos) : 0
    const adic = conAjustes ? importe(adiciones) : 0
    const neto = redondear(base - desc + adic)
    if (neto <= 0) throw new Error('Los descuentos no pueden ser iguales o mayores al sueldo más las adiciones.')
    const dia = fecha || actual.fecha || hoyISO()
    const nombre = `${emp.nombre} ${emp.apellido || ''}`.trim()
    const detalle = (descripcion || '').trim()

    await transaction(async (q) => {
      await q(`
        UPDATE pagos_empleado SET id_empleado = ?, periodo = ?, monto = ?, sueldo_base = ?, descuentos = ?, adiciones = ?,
                                  fecha = ?, descripcion = ?, metodo_pago = ?
        WHERE id = ?
      `, [emp.id, periodo || null, neto, base, desc, adic, dia, detalle, metodo_pago || null, id])
      const texto = [`${TIPO_LABEL[tipo]} — ${nombre}`, periodo ? `(${periodo})` : '', detalle ? `— ${detalle}` : ''].filter(Boolean).join(' ')
      await q(`
        UPDATE egresos SET fecha = ?, descripcion = ?, monto = ?, metodo_pago = ?, id_empleado = ?
        WHERE id_pago_empleado = ? ${actual.id_egreso ? 'OR id = ?' : ''}
      `, [dia, texto, neto, metodo_pago || null, emp.id, id, ...(actual.id_egreso ? [actual.id_egreso] : [])])
    })
    return { neto, base, descuentos: desc, adiciones: adic }
  },

  // Borra el pago y su egreso vinculado (si hay). `id_empleado` es opcional: cuando viene
  // (desde la ficha del chofer) solo borra si el pago realmente es de ese empleado.
  async eliminar(id, id_empleado) {
    await transaction(async (q) => {
      const p = (await q(`SELECT id, id_egreso, id_empleado FROM pagos_empleado WHERE id = ?`, [id])).rows[0]
      if (!p) return
      if (id_empleado != null && String(p.id_empleado) !== String(id_empleado)) return
      // Lo pagó un cliente con una transferencia a tercero: es parte de ese cobro. Borrarlo
      // solo acá dejaría el cobro del cliente sin su contraparte; se deshace desde el cobro.
      const deTercero = (await q(`SELECT 1 FROM egresos WHERE (id_pago_empleado = ? OR id = ?) AND origen = 'tercero' LIMIT 1`,
        [id, p.id_egreso || 0])).rows[0]
      if (deTercero) {
        throw new Error('Este pago lo hizo un cliente con una transferencia: no se borra desde acá. Para deshacerlo, corregí o anulá el cobro del cliente (en Transacciones o en su cuenta corriente).')
      }
      await q(`DELETE FROM egresos WHERE id_pago_empleado = ?`, [id])
      if (p.id_egreso) await q(`DELETE FROM egresos WHERE id = ?`, [p.id_egreso])
      await q(`DELETE FROM pagos_empleado WHERE id = ?`, [id])
    })
  },

  async resumen(id_empleado, { desde, hasta } = {}) {
    const wheres = ['id_empleado = ?']
    const params = [id_empleado]
    if (desde) { wheres.push('fecha >= ?'); params.push(desde) }
    if (hasta) { wheres.push('fecha <= ?'); params.push(hasta) }
    const rows = (await query(`
      SELECT tipo, COALESCE(SUM(monto),0) AS total, COUNT(*) AS n
      FROM pagos_empleado WHERE ${wheres.join(' AND ')} GROUP BY tipo
    `, params)).rows
    const porTipo = {}
    let neto = 0
    rows.forEach(r => { porTipo[r.tipo] = r.total; neto += RESTAN.has(r.tipo) ? -r.total : r.total })
    return { porTipo, neto, count: rows.reduce((a, r) => a + r.n, 0) }
  },
}

module.exports = PagosEmpleadoModel
