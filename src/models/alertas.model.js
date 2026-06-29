'use strict'
// ─────────────────────────────────────────────────────────────────
// Motor de alertas — calcula vencimientos y pendientes on-the-fly.
// Fuentes: documentos, licencias (empleados), seguros/VTV/gastos,
// mantenimiento (km/fecha), camiones inactivos, choferes sin asignación.
// Severidad por días restantes: vencido / critico(≤30) / alto(≤60) / medio(≤90).
// ─────────────────────────────────────────────────────────────────
const { query } = require('../config/db')

const HOY = () => {
  const d = new Date()
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

// Días desde hoy hasta una fecha ISO (YYYY-MM-DD...). Negativo = vencido.
function diasHasta(fechaISO) {
  if (!fechaISO) return null
  const s = String(fechaISO).slice(0, 10)
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return null
  const f = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return Math.round((f - HOY()) / 86400000)
}

function severidad(dias) {
  if (dias == null) return null
  if (dias < 0) return 'vencido'
  if (dias <= 30) return 'critico'
  if (dias <= 60) return 'alto'
  if (dias <= 90) return 'medio'
  return null // fuera de ventana de alerta
}

// Severidad dentro de una ventana de anticipación configurable (días).
// Gradúa critico/alto/medio según proximidad; null fuera de ventana.
function severidadVentana(dias, ventana) {
  if (dias == null) return null
  if (dias < 0) return 'vencido'
  const w = Number(ventana) > 0 ? Number(ventana) : 30
  if (dias > w) return null
  if (dias <= Math.ceil(w / 3)) return 'critico'
  if (dias <= Math.ceil((2 * w) / 3)) return 'alto'
  return 'medio'
}

const SEV_ORDER = { vencido: 0, critico: 1, alto: 2, medio: 3 }

const AlertasModel = {

  // Devuelve TODAS las alertas activas (array plano, ordenado por urgencia).
  async listar({ modulo, tipo, severidad: sevFiltro } = {}) {
    const out = []
    const push = (a) => { if (a.severidad) out.push(a) }

    // ── Licencias de choferes/empleados (anticipación configurable) ──
    ;(await query(`
      SELECT id, nombre, apellido, licencia_vencimiento, licencia_dias_alerta, es_chofer
      FROM empleados WHERE activo = 1 AND licencia_vencimiento IS NOT NULL AND licencia_vencimiento != ''
    `)).rows.forEach(e => {
      const dias = diasHasta(e.licencia_vencimiento)
      push({
        modulo: 'choferes', tipo: 'licencia',
        severidad: severidadVentana(dias, e.licencia_dias_alerta || 30), dias,
        titulo: 'Licencia de conducir',
        entidad_id: e.id, entidad_nombre: `${e.nombre} ${e.apellido || ''}`.trim(),
        fecha: e.licencia_vencimiento, link: `/choferes/${e.id}`,
      })
    })

    // ── Vencimiento de pago de empleados (alerta 7 días antes) ──────
    ;(await query(`
      SELECT id, nombre, apellido, fecha_vencimiento_pago
      FROM empleados WHERE activo = 1 AND fecha_vencimiento_pago IS NOT NULL AND fecha_vencimiento_pago != ''
    `)).rows.forEach(e => {
      const dias = diasHasta(e.fecha_vencimiento_pago)
      push({
        modulo: 'choferes', tipo: 'pago',
        severidad: severidadVentana(dias, 7), dias,
        titulo: 'Vencimiento de pago',
        entidad_id: e.id, entidad_nombre: `${e.nombre} ${e.apellido || ''}`.trim(),
        fecha: e.fecha_vencimiento_pago, link: `/choferes/${e.id}`,
        resolver: `/choferes/${e.id}/pago-vencimiento/resolver`,
      })
    })

    // ── Documentos (empleados y vehículos) ────────────────────────
    ;(await query(`
      SELECT d.*,
        CASE WHEN d.entidad_tipo='empleado' THEN (SELECT nombre||' '||COALESCE(apellido,'') FROM empleados WHERE id=d.entidad_id)
             ELSE (SELECT COALESCE(nombre,'')||' ('||COALESCE(patente,'')||')' FROM flota_vehiculos WHERE id=d.entidad_id) END AS nom
      FROM documentos d
      WHERE d.fecha_vencimiento IS NOT NULL AND d.fecha_vencimiento != ''
    `)).rows.forEach(d => {
      const dias = diasHasta(d.fecha_vencimiento)
      push({
        modulo: d.entidad_tipo === 'empleado' ? 'choferes' : 'flota',
        tipo: 'documento',
        severidad: severidadVentana(dias, d.dias_alerta || 30), dias,
        titulo: d.tipo || 'Documento',
        entidad_id: d.entidad_id, entidad_nombre: d.nom || '—',
        fecha: d.fecha_vencimiento,
        link: d.entidad_tipo === 'empleado' ? `/choferes/${d.entidad_id}` : `/flota/${d.entidad_id}`,
      })
    })

    // ── Gastos con vencimiento (seguros, impuestos) ───────────────
    ;(await query(`
      SELECT g.*, (SELECT COALESCE(nombre,'')||' ('||COALESCE(patente,'')||')' FROM flota_vehiculos WHERE id=g.id_vehiculo) AS nom
      FROM gastos_vehiculo g
      WHERE g.vencimiento IS NOT NULL AND g.vencimiento != ''
    `)).rows.forEach(g => {
      const dias = diasHasta(g.vencimiento)
      push({
        modulo: 'flota', tipo: g.categoria === 'seguro' ? 'seguro' : 'gasto',
        severidad: severidad(dias), dias,
        titulo: g.categoria === 'seguro' ? 'Seguro del vehículo' : `Vencimiento: ${g.categoria}`,
        entidad_id: g.id_vehiculo, entidad_nombre: g.nom || '—',
        fecha: g.vencimiento, link: `/flota/${g.id_vehiculo}`,
      })
    })

    // ── Mantenimiento por fecha (reglas cada_meses) ───────────────
    const reglasFecha = (await query(`SELECT * FROM config_mantenimiento WHERE cada_meses IS NOT NULL`)).rows
    for (const regla of reglasFecha) {
      const vehiculos = regla.id_vehiculo
        ? (await query(`SELECT id, nombre, patente, kilometraje FROM flota_vehiculos WHERE id = ?`, [regla.id_vehiculo])).rows
        : (await query(`SELECT id, nombre, patente, kilometraje FROM flota_vehiculos WHERE activo = 1`)).rows
      for (const v of vehiculos) {
        const ultimo = (await query(`
          SELECT fecha FROM mantenimiento_vehiculo WHERE id_vehiculo = ? ORDER BY fecha DESC LIMIT 1
        `, [v.id])).rows[0]
        if (!ultimo || !ultimo.fecha) continue
        const prox = new Date(String(ultimo.fecha).slice(0, 10))
        prox.setMonth(prox.getMonth() + regla.cada_meses)
        const iso = prox.toISOString().slice(0, 10)
        const dias = diasHasta(iso)
        push({
          modulo: 'flota', tipo: 'mantenimiento',
          severidad: severidad(dias), dias,
          titulo: `Service: ${regla.tipo || regla.descripcion || 'programado'}`,
          entidad_id: v.id, entidad_nombre: `${v.nombre || ''} (${v.patente || ''})`,
          fecha: iso, link: `/flota/${v.id}`,
        })
      }
    }

    // ── Mantenimiento por km (reglas cada_km) ─────────────────────
    const reglasKm = (await query(`SELECT * FROM config_mantenimiento WHERE cada_km IS NOT NULL`)).rows
    for (const regla of reglasKm) {
      const vehiculos = regla.id_vehiculo
        ? (await query(`SELECT id, nombre, patente, kilometraje FROM flota_vehiculos WHERE id = ?`, [regla.id_vehiculo])).rows
        : (await query(`SELECT id, nombre, patente, kilometraje FROM flota_vehiculos WHERE activo = 1`)).rows
      for (const v of vehiculos) {
        const ultimo = (await query(`
          SELECT COALESCE(km,0) AS km FROM mantenimiento_vehiculo WHERE id_vehiculo = ? ORDER BY fecha DESC LIMIT 1
        `, [v.id])).rows[0]
        const kmBase = ultimo ? ultimo.km : 0
        const kmProx = kmBase + regla.cada_km
        const restante = kmProx - (v.kilometraje || 0)
        let sev = null
        if (restante < 0) sev = 'vencido'
        else if (restante <= 500) sev = 'critico'
        else if (restante <= 1500) sev = 'alto'
        else if (restante <= 3000) sev = 'medio'
        if (sev) push({
          modulo: 'flota', tipo: 'mantenimiento',
          severidad: sev, dias: null, km_restante: restante,
          titulo: `Service por km: ${regla.tipo || regla.descripcion || 'programado'}`,
          entidad_id: v.id, entidad_nombre: `${v.nombre || ''} (${v.patente || ''})`,
          fecha: null, link: `/flota/${v.id}`,
        })
      }
    }

    // ── Camiones inactivos / fuera de servicio ────────────────────
    ;(await query(`
      SELECT id, nombre, patente, estado_operativo FROM flota_vehiculos
      WHERE activo = 1 AND estado_operativo IN ('inactivo','fuera_servicio')
    `)).rows.forEach(v => {
      push({
        modulo: 'flota', tipo: 'inactivo', severidad: 'medio', dias: null,
        titulo: `Camión ${v.estado_operativo === 'inactivo' ? 'inactivo' : 'fuera de servicio'}`,
        entidad_id: v.id, entidad_nombre: `${v.nombre || ''} (${v.patente || ''})`,
        fecha: null, link: `/flota/${v.id}`,
      })
    })

    // ── Choferes sin asignación de camión ─────────────────────────
    ;(await query(`
      SELECT e.id, e.nombre, e.apellido FROM empleados e
      WHERE e.activo = 1 AND e.es_chofer = 1
        AND NOT EXISTS (SELECT 1 FROM asignaciones_recurso a WHERE a.id_empleado = e.id AND a.recurso_tipo = 'camion' AND a.activo = 1)
    `)).rows.forEach(e => {
      push({
        modulo: 'choferes', tipo: 'sin_asignacion', severidad: 'medio', dias: null,
        titulo: 'Chofer sin camión asignado',
        entidad_id: e.id, entidad_nombre: `${e.nombre} ${e.apellido || ''}`.trim(),
        fecha: null, link: `/choferes/${e.id}`,
      })
    })

    // ── Filtros + orden ───────────────────────────────────────────
    let res = out
    if (modulo)    res = res.filter(a => a.modulo === modulo)
    if (tipo)      res = res.filter(a => a.tipo === tipo)
    if (sevFiltro) res = res.filter(a => a.severidad === sevFiltro)
    res.sort((a, b) => (SEV_ORDER[a.severidad] - SEV_ORDER[b.severidad]) || ((a.dias ?? 9999) - (b.dias ?? 9999)))
    return res
  },

  // Conteos por severidad + total (para badges/dashboard).
  async resumen(filtros = {}) {
    const todas = await this.listar(filtros)
    const r = { total: todas.length, vencido: 0, critico: 0, alto: 0, medio: 0, choferes: 0, flota: 0 }
    todas.forEach(a => { r[a.severidad]++; r[a.modulo]++ })
    return r
  },
}

module.exports = AlertasModel
