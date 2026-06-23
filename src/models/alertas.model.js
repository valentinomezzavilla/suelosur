'use strict'
// ─────────────────────────────────────────────────────────────────
// Motor de alertas — calcula vencimientos y pendientes on-the-fly.
// Fuentes: documentos, licencias (empleados), seguros/VTV/gastos,
// mantenimiento (km/fecha), camiones inactivos, choferes sin asignación.
// Severidad por días restantes: vencido / critico(≤30) / alto(≤60) / medio(≤90).
// ─────────────────────────────────────────────────────────────────
const db = require('../config/db')

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

const SEV_ORDER = { vencido: 0, critico: 1, alto: 2, medio: 3 }

const AlertasModel = {

  // Devuelve TODAS las alertas activas (array plano, ordenado por urgencia).
  listar({ modulo, tipo, severidad: sevFiltro } = {}) {
    const out = []
    const push = (a) => { if (a.severidad) out.push(a) }

    // ── Licencias de choferes/empleados ───────────────────────────
    db.prepare(`
      SELECT id, nombre, apellido, licencia_vencimiento, es_chofer
      FROM empleados WHERE activo = 1 AND licencia_vencimiento IS NOT NULL AND licencia_vencimiento != ''
    `).all().forEach(e => {
      const dias = diasHasta(e.licencia_vencimiento)
      push({
        modulo: 'choferes', tipo: 'licencia',
        severidad: severidad(dias), dias,
        titulo: 'Licencia de conducir',
        entidad_id: e.id, entidad_nombre: `${e.nombre} ${e.apellido || ''}`.trim(),
        fecha: e.licencia_vencimiento, link: `/choferes/${e.id}`,
      })
    })

    // ── Documentos (empleados y vehículos) ────────────────────────
    db.prepare(`
      SELECT d.*,
        CASE WHEN d.entidad_tipo='empleado' THEN (SELECT nombre||' '||COALESCE(apellido,'') FROM empleados WHERE id=d.entidad_id)
             ELSE (SELECT COALESCE(nombre,'')||' ('||COALESCE(patente,'')||')' FROM flota_vehiculos WHERE id=d.entidad_id) END AS nom
      FROM documentos d
      WHERE d.fecha_vencimiento IS NOT NULL AND d.fecha_vencimiento != ''
    `).all().forEach(d => {
      const dias = diasHasta(d.fecha_vencimiento)
      push({
        modulo: d.entidad_tipo === 'empleado' ? 'choferes' : 'flota',
        tipo: 'documento',
        severidad: severidad(dias), dias,
        titulo: d.tipo || 'Documento',
        entidad_id: d.entidad_id, entidad_nombre: d.nom || '—',
        fecha: d.fecha_vencimiento,
        link: d.entidad_tipo === 'empleado' ? `/choferes/${d.entidad_id}` : `/flota/${d.entidad_id}`,
      })
    })

    // ── Gastos con vencimiento (seguros, impuestos) ───────────────
    db.prepare(`
      SELECT g.*, (SELECT COALESCE(nombre,'')||' ('||COALESCE(patente,'')||')' FROM flota_vehiculos WHERE id=g.id_vehiculo) AS nom
      FROM gastos_vehiculo g
      WHERE g.vencimiento IS NOT NULL AND g.vencimiento != ''
    `).all().forEach(g => {
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
    db.prepare(`SELECT * FROM config_mantenimiento WHERE cada_meses IS NOT NULL`).all().forEach(regla => {
      const vehiculos = regla.id_vehiculo
        ? db.prepare(`SELECT id, nombre, patente, kilometraje FROM flota_vehiculos WHERE id = ?`).all(regla.id_vehiculo)
        : db.prepare(`SELECT id, nombre, patente, kilometraje FROM flota_vehiculos WHERE activo = 1`).all()
      vehiculos.forEach(v => {
        const ultimo = db.prepare(`
          SELECT fecha FROM mantenimiento_vehiculo WHERE id_vehiculo = ? ORDER BY fecha DESC LIMIT 1
        `).get(v.id)
        if (!ultimo || !ultimo.fecha) return
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
      })
    })

    // ── Mantenimiento por km (reglas cada_km) ─────────────────────
    db.prepare(`SELECT * FROM config_mantenimiento WHERE cada_km IS NOT NULL`).all().forEach(regla => {
      const vehiculos = regla.id_vehiculo
        ? db.prepare(`SELECT id, nombre, patente, kilometraje FROM flota_vehiculos WHERE id = ?`).all(regla.id_vehiculo)
        : db.prepare(`SELECT id, nombre, patente, kilometraje FROM flota_vehiculos WHERE activo = 1`).all()
      vehiculos.forEach(v => {
        const ultimo = db.prepare(`
          SELECT COALESCE(km,0) AS km FROM mantenimiento_vehiculo WHERE id_vehiculo = ? ORDER BY fecha DESC LIMIT 1
        `).get(v.id)
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
      })
    })

    // ── Camiones inactivos / fuera de servicio ────────────────────
    db.prepare(`
      SELECT id, nombre, patente, estado_operativo FROM flota_vehiculos
      WHERE activo = 1 AND estado_operativo IN ('inactivo','fuera_servicio')
    `).all().forEach(v => {
      push({
        modulo: 'flota', tipo: 'inactivo', severidad: 'medio', dias: null,
        titulo: `Camión ${v.estado_operativo === 'inactivo' ? 'inactivo' : 'fuera de servicio'}`,
        entidad_id: v.id, entidad_nombre: `${v.nombre || ''} (${v.patente || ''})`,
        fecha: null, link: `/flota/${v.id}`,
      })
    })

    // ── Choferes sin asignación de camión ─────────────────────────
    db.prepare(`
      SELECT e.id, e.nombre, e.apellido FROM empleados e
      WHERE e.activo = 1 AND e.es_chofer = 1
        AND NOT EXISTS (SELECT 1 FROM asignaciones_recurso a WHERE a.id_empleado = e.id AND a.recurso_tipo = 'camion' AND a.activo = 1)
    `).all().forEach(e => {
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
  resumen(filtros = {}) {
    const todas = this.listar(filtros)
    const r = { total: todas.length, vencido: 0, critico: 0, alto: 0, medio: 0, choferes: 0, flota: 0 }
    todas.forEach(a => { r[a.severidad]++; r[a.modulo]++ })
    return r
  },
}

module.exports = AlertasModel
