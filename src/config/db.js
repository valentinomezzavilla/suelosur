'use strict'
// ═══════════════════════════════════════════════════════════════════
// db.js — Base de datos · Suelosur S.A.S.
// pg (async) · PostgreSQL / Supabase
// ═══════════════════════════════════════════════════════════════════

const { Pool, types } = require('pg')
const bcrypt  = require('bcryptjs')

// Parsear NUMERIC / BIGINT / INT8 como números JS (no como strings).
// Sin esto, sumas como "$1500" se ven como "1500" sin formato porque toLocaleString()
// sobre un string no aplica el separador de miles.
types.setTypeParser(1700, (v) => v == null ? null : parseFloat(v)) // NUMERIC
types.setTypeParser(20,   (v) => v == null ? null : parseInt(v, 10)) // BIGINT / int8

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,                       // máximo de conexiones simultáneas
  idleTimeoutMillis: 30000,      // cerrar conexiones idle a los 30s
  connectionTimeoutMillis: 10000,// timeout para conectar (10s)
  statement_timeout: 30000,      // matar queries que tarden +30s
})

// Evitar que un error suelto del pool tire el proceso
pool.on('error', (err) => {
  console.error('Pool PG error (idle client):', err.message)
})

// Convierte placeholders ? → $1, $2, ... para PostgreSQL
async function query(sql, params = []) {
  let i = 0
  const pgSql = sql.replace(/\?/g, () => `$${++i}`)
  return pool.query(pgSql, params)
}

// Ejecuta fn(q) dentro de una transacción; q es el mismo helper ? → $N
async function transaction(fn) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const q = (sql, params = []) => {
      let i = 0
      return client.query(sql.replace(/\?/g, () => `$${++i}`), params)
    }
    const result = await fn(q)
    await client.query('COMMIT')
    return result
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }
}

// ═══════════════════════════════════════════════════════════════════
// initDB — crea tablas, migraciones, seeds y backfills
// ═══════════════════════════════════════════════════════════════════
async function initDB() {

  // ─────────────────────────────────────────────────────────────────
  // BLOQUE 1 — TABLAS CENTRALES
  // ─────────────────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      usuario       TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      nombre        TEXT NOT NULL,
      rol           TEXT NOT NULL CHECK (rol IN ('admin_ventas','admin_contable','chofer','dueno')),
      activo        INTEGER DEFAULT 1,
      created_at    TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS clientes (
      id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      nombre           TEXT NOT NULL,
      apellido         TEXT NOT NULL DEFAULT '',
      dni              TEXT,
      domicilio_ppal   TEXT,
      zona             TEXT,
      tel_whatsapp     TEXT,
      telefono         TEXT,
      email            TEXT,
      tipo_cliente     TEXT,
      cuenta_corriente INTEGER DEFAULT 0,
      saldo            REAL DEFAULT 0,
      activo           INTEGER DEFAULT 1,
      numero           INTEGER,
      created_at       TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )
  `)
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_clientes_numero ON clientes(numero)`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS movimientos_cuenta (
      id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      cliente_id  BIGINT NOT NULL REFERENCES clientes(id),
      tipo        TEXT NOT NULL CHECK (tipo IN ('deuda','pago','ajuste')),
      descripcion TEXT NOT NULL DEFAULT '',
      monto       REAL NOT NULL,
      created_at  TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS productos (
      id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      nombre            TEXT NOT NULL,
      unidad_medida     TEXT NOT NULL DEFAULT 'm³',
      precio_referencia REAL DEFAULT 0,
      activo            INTEGER DEFAULT 1,
      created_at        TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS stock (
      id                      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      id_producto             BIGINT NOT NULL UNIQUE REFERENCES productos(id),
      cantidad_actual         REAL DEFAULT 0,
      cant_pendiente_entregar REAL DEFAULT 0,
      stock_minimo            REAL DEFAULT 0
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS flota_vehiculos (
      id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      tipo_vehiculo    TEXT NOT NULL CHECK (tipo_vehiculo IN ('camion','bobcat','utilitario','otro')),
      patente          TEXT NOT NULL,
      nombre           TEXT NOT NULL,
      kilometraje      INTEGER DEFAULT 0,
      activo           INTEGER DEFAULT 1,
      marca            TEXT,
      modelo           TEXT,
      anio             INTEGER,
      nro_chasis       TEXT,
      nro_motor        TEXT,
      tipo_unidad      TEXT,
      capacidad_carga  REAL,
      estado_operativo TEXT DEFAULT 'disponible',
      numero_interno   INTEGER,
      fecha_ultimo_mant  TEXT,
      fecha_proximo_mant TEXT,
      observaciones    TEXT DEFAULT '',
      dedicacion       TEXT DEFAULT 'ambos',
      created_at       TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )
  `)

  // ─────────────────────────────────────────────────────────────────
  // BLOQUE 2 — OPERACIONES
  // ─────────────────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS op_encabezado (
      id                        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      id_cliente                BIGINT NOT NULL REFERENCES clientes(id),
      id_administrativo         BIGINT NOT NULL REFERENCES users(id),
      fecha_emision             TEXT NOT NULL DEFAULT to_char(CURRENT_DATE, 'YYYY-MM-DD'),
      tipo_op                   TEXT NOT NULL DEFAULT 'M' CHECK (tipo_op IN ('M','C','MA')),
      nro_op                    INTEGER NOT NULL,
      nro_remito                INTEGER,
      estado                    TEXT NOT NULL DEFAULT 'pendiente'
                                  CHECK (estado IN ('pendiente','despachado','entregado','anulado')),
      modalidad                 TEXT CHECK (modalidad IN ('deposito','flete') OR modalidad IS NULL),
      metodo_pago               TEXT CHECK (metodo_pago IN ('efectivo','transferencia','cheque','cuenta_corriente') OR metodo_pago IS NULL),
      observaciones             TEXT DEFAULT '',
      fecha_entrega_planificada TEXT,
      domicilio_calle           TEXT,
      domicilio_altura          INTEGER,
      domicilio_sin_numero      INTEGER DEFAULT 0,
      domicilio_lat             REAL,
      domicilio_lng             REAL,
      estado_programacion       TEXT DEFAULT NULL,
      archivo_remito            TEXT,
      id_chofer                 BIGINT,
      id_camion                 BIGINT,
      asignacion_fecha          TEXT,
      asignacion_usuario        BIGINT,
      firma_cliente             TEXT,
      firma_aclaracion          TEXT,
      archivo_remito_pdf        TEXT,
      firma_retiro              TEXT,
      firma_retiro_aclaracion   TEXT,
      archivo_remito_retiro     TEXT,
      created_at                TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )
  `)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS op_detalle_material (
      id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      id_orden_pedido BIGINT NOT NULL REFERENCES op_encabezado(id),
      id_producto     BIGINT NOT NULL REFERENCES productos(id),
      cantidad_pedida REAL NOT NULL,
      precio_unitario REAL NOT NULL
    )
  `)

  // Catálogos referenciados por op_detalle_*: deben crearse ANTES
  await pool.query(`
    CREATE TABLE IF NOT EXISTS contenedores (
      id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      numero_contenedor    INTEGER NOT NULL UNIQUE,
      estado_general       TEXT NOT NULL DEFAULT 'operativo'
                             CHECK (estado_general IN ('operativo','en_reparacion','baja')),
      fecha_ultima_pintada TEXT,
      observaciones        TEXT DEFAULT '',
      activo               INTEGER DEFAULT 1,
      created_at           TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS maquinaria (
      id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      nombre          TEXT NOT NULL,
      tipo            TEXT NOT NULL DEFAULT 'bobcat'
                        CHECK (tipo IN ('bobcat','minicargadora','retroexcavadora','otro')),
      patente         TEXT,
      modelo          TEXT,
      anio            INTEGER,
      estado_general  TEXT NOT NULL DEFAULT 'operativo'
                        CHECK (estado_general IN ('operativo','en_servicio','baja')),
      km_actuales     INTEGER DEFAULT 0,
      ultimo_service  TEXT,
      proximo_service TEXT,
      observaciones   TEXT DEFAULT '',
      activo          INTEGER DEFAULT 1,
      precio_por_hora REAL DEFAULT 0,
      precio_por_dia  REAL DEFAULT 0,
      modo_precio     TEXT DEFAULT 'hora',
      numero_interno  INTEGER,
      horas_uso       REAL DEFAULT 0,
      estado_operativo TEXT DEFAULT 'disponible',
      marca           TEXT,
      created_at      TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS op_detalle_contenedor (
      id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      id_orden_pedido      BIGINT NOT NULL REFERENCES op_encabezado(id),
      id_contenedor        BIGINT REFERENCES contenedores(id),
      domicilio_entrega    TEXT NOT NULL DEFAULT '',
      zona_entrega         TEXT NOT NULL DEFAULT '',
      plazo_alquiler       INTEGER NOT NULL DEFAULT 5,
      precio_alquiler      REAL DEFAULT 0,
      domicilio_calle      TEXT,
      domicilio_numero     TEXT,
      domicilio_lat        REAL,
      domicilio_lng        REAL,
      alquiler_siguiente_id BIGINT,
      metodo_pago          TEXT
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS op_detalle_maquinaria (
      id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      id_orden_pedido   BIGINT NOT NULL REFERENCES op_encabezado(id),
      id_maquinaria     BIGINT REFERENCES maquinaria(id),
      domicilio_entrega TEXT NOT NULL DEFAULT '',
      zona_entrega      TEXT NOT NULL DEFAULT '',
      plazo_alquiler    INTEGER NOT NULL DEFAULT 1,
      precio_por_hora   REAL DEFAULT 0,
      horas_pactadas    REAL DEFAULT 0,
      precio_total      REAL DEFAULT 0,
      id_chofer         BIGINT REFERENCES users(id),
      domicilio_calle   TEXT,
      domicilio_numero  TEXT,
      metodo_pago       TEXT
    )
  `)

  // ─────────────────────────────────────────────────────────────────
  // BLOQUE 3 — CONTENEDORES (movimientos; tabla principal creada arriba)
  // ─────────────────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS movimiento_contenedor (
      id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      id_contenedor    BIGINT NOT NULL REFERENCES contenedores(id),
      id_op_contenedor BIGINT REFERENCES op_detalle_contenedor(id),
      id_chofer        BIGINT REFERENCES users(id),
      id_camion        BIGINT REFERENCES flota_vehiculos(id),
      fecha_movimiento TEXT NOT NULL DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
      estado_paso      TEXT NOT NULL
                         CHECK (estado_paso IN (
                           'disponible','pendiente_despacho','despachado',
                           'en_alquiler','pendiente_retiro','vuelta_a_planta'
                         )),
      observaciones    TEXT DEFAULT ''
    )
  `)

  // ─────────────────────────────────────────────────────────────────
  // BLOQUE 4 — MAQUINARIA (movimientos; tabla principal creada arriba)
  // ─────────────────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS movimiento_maquinaria (
      id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      id_maquinaria    BIGINT NOT NULL REFERENCES maquinaria(id),
      id_op_maquinaria BIGINT REFERENCES op_detalle_maquinaria(id),
      id_operario      BIGINT REFERENCES users(id),
      id_camion        BIGINT REFERENCES flota_vehiculos(id),
      fecha_movimiento TEXT NOT NULL DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
      estado_paso      TEXT NOT NULL
                         CHECK (estado_paso IN (
                           'en_planta','despachada','en_uso','a_retirar','en_servicio'
                         )),
      horas_trabajadas REAL DEFAULT 0,
      km_registrados   INTEGER DEFAULT 0,
      observaciones    TEXT DEFAULT ''
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS mantenimiento_maquinaria (
      id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      id_maquinaria BIGINT NOT NULL REFERENCES maquinaria(id),
      tipo_service  TEXT NOT NULL DEFAULT 'preventivo'
                      CHECK (tipo_service IN ('preventivo','correctivo','revision')),
      fecha         TEXT NOT NULL,
      costo         REAL DEFAULT 0,
      km_al_service INTEGER DEFAULT 0,
      proximo_fecha TEXT,
      taller        TEXT DEFAULT '',
      descripcion   TEXT DEFAULT '',
      created_at    TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )
  `)

  // ─────────────────────────────────────────────────────────────────
  // BLOQUE 5 — TRANSACCIONES
  // ─────────────────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS transacciones (
      id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      tipo             TEXT NOT NULL
                         CHECK (tipo IN (
                           'Venta Cantera','Venta Viaje',
                           'Alquiler','Maquinaria','Ajuste'
                         )),
      id_op_encabezado BIGINT REFERENCES op_encabezado(id),
      nro_remito       INTEGER,
      cliente_id       BIGINT REFERENCES clientes(id),
      cliente          TEXT NOT NULL DEFAULT '',
      monto            REAL NOT NULL DEFAULT 0,
      descripcion      TEXT DEFAULT '',
      metodo_pago      TEXT NOT NULL DEFAULT 'efectivo'
                         CHECK (metodo_pago IN (
                           'efectivo','transferencia','cheque','cuenta_corriente'
                         )),
      fecha            TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
      numero           INTEGER,
      created_at       TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )
  `)

  // ─────────────────────────────────────────────────────────────────
  // BLOQUE 6 — CIRCUITOS LOGÍSTICOS
  // ─────────────────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS circuitos (
      id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      fecha         TEXT NOT NULL DEFAULT to_char(CURRENT_DATE, 'YYYY-MM-DD'),
      id_chofer     BIGINT REFERENCES users(id),
      id_camion     BIGINT REFERENCES flota_vehiculos(id),
      id_empleado   BIGINT,
      estado        TEXT NOT NULL DEFAULT 'borrador'
                      CHECK (estado IN ('borrador','confirmado','en_curso','finalizado')),
      observaciones TEXT DEFAULT '',
      created_at    TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS circuito_paradas (
      id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      id_circuito      BIGINT NOT NULL REFERENCES circuitos(id),
      id_op_encabezado BIGINT REFERENCES op_encabezado(id),
      orden            INTEGER NOT NULL DEFAULT 1,
      tipo_parada      TEXT NOT NULL
                         CHECK (tipo_parada IN (
                           'entrega_material','entrega_contenedor',
                           'retiro_contenedor','entrega_maquinaria',
                           'retiro_maquinaria'
                         )),
      domicilio        TEXT DEFAULT '',
      zona             TEXT DEFAULT '',
      hora_estimada    TEXT,
      estado           TEXT NOT NULL DEFAULT 'pendiente'
                         CHECK (estado IN ('pendiente','completada','cancelada')),
      observaciones    TEXT DEFAULT '',
      created_at       TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )
  `)

  // ─────────────────────────────────────────────────────────────────
  // BLOQUE 7 — COMPRAS Y PROVEEDORES
  // ─────────────────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS proveedores (
      id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      nombre     TEXT NOT NULL,
      cuit       TEXT,
      domicilio  TEXT,
      telefono   TEXT,
      email      TEXT,
      activo     INTEGER DEFAULT 1,
      created_at TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS compras_encabezado (
      id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      id_proveedor  BIGINT NOT NULL REFERENCES proveedores(id),
      fecha         TEXT NOT NULL DEFAULT to_char(CURRENT_DATE, 'YYYY-MM-DD'),
      estado        TEXT NOT NULL DEFAULT 'emitida'
                      CHECK (estado IN ('emitida','recibida','cancelada')),
      observaciones TEXT DEFAULT '',
      created_at    TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS compras_detalle (
      id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      id_compra       BIGINT NOT NULL REFERENCES compras_encabezado(id),
      id_producto     BIGINT NOT NULL REFERENCES productos(id),
      cantidad        REAL NOT NULL,
      precio_unitario REAL NOT NULL
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS cc_proveedores (
      id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      id_proveedor     BIGINT NOT NULL REFERENCES proveedores(id),
      tipo_movimiento  TEXT NOT NULL CHECK (tipo_movimiento IN ('debito','credito')),
      nro_comprobante  TEXT,
      monto_debito     REAL DEFAULT 0,
      monto_credito    REAL DEFAULT 0,
      saldo_resultante REAL DEFAULT 0,
      descripcion      TEXT DEFAULT '',
      fecha            TEXT DEFAULT to_char(CURRENT_DATE, 'YYYY-MM-DD'),
      created_at       TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )
  `)

  // ─────────────────────────────────────────────────────────────────
  // BLOQUE 8 — FLOTA Y MANTENIMIENTO
  // ─────────────────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mantenimiento_vehiculo (
      id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      id_vehiculo   BIGINT NOT NULL REFERENCES flota_vehiculos(id),
      tipo_service  TEXT NOT NULL DEFAULT 'preventivo'
                      CHECK (tipo_service IN ('preventivo','correctivo','revision')),
      fecha         TEXT NOT NULL,
      costo         REAL DEFAULT 0,
      km            INTEGER DEFAULT 0,
      proxima_fecha TEXT,
      taller        TEXT DEFAULT '',
      observaciones TEXT DEFAULT '',
      categoria     TEXT DEFAULT 'preventivo',
      descripcion   TEXT DEFAULT '',
      proximo_km    INTEGER,
      archivo       TEXT,
      created_at    TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS combustible (
      id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      id_vehiculo  BIGINT NOT NULL REFERENCES flota_vehiculos(id),
      id_chofer    BIGINT REFERENCES users(id),
      litros       REAL NOT NULL,
      costo_total  REAL NOT NULL,
      km_al_cargar INTEGER DEFAULT 0,
      fecha        TEXT NOT NULL DEFAULT to_char(CURRENT_DATE, 'YYYY-MM-DD'),
      estacion     TEXT,
      created_at   TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )
  `)

  // ─────────────────────────────────────────────────────────────────
  // BLOQUE 9 — FLOTA DE PERSONAL (RRHH)
  // ─────────────────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS empleados (
      id                        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      legajo                    INTEGER UNIQUE,
      nombre                    TEXT NOT NULL,
      apellido                  TEXT NOT NULL DEFAULT '',
      dni                       TEXT,
      fecha_nacimiento          TEXT,
      direccion                 TEXT,
      telefono                  TEXT,
      email                     TEXT,
      cargo                     TEXT,
      sector                    TEXT,
      fecha_ingreso             TEXT,
      estado_laboral            TEXT NOT NULL DEFAULT 'activo'
                                  CHECK (estado_laboral IN ('activo','licencia','suspendido','baja')),
      tipo_contratacion         TEXT,
      salario                   REAL DEFAULT 0,
      bonificaciones            REAL DEFAULT 0,
      descuentos                REAL DEFAULT 0,
      viaticos                  REAL DEFAULT 0,
      horas_extras              REAL DEFAULT 0,
      vehiculo_asignado         TEXT,
      licencia_categoria        TEXT,
      licencia_vencimiento      TEXT,
      certificaciones           TEXT,
      id_usuario                BIGINT REFERENCES users(id),
      activo                    INTEGER DEFAULT 1,
      cuil                      TEXT,
      contacto_emergencia       TEXT,
      contacto_emergencia_tel   TEXT,
      convenio                  TEXT,
      categoria_laboral         TEXT,
      sueldo_basico             REAL DEFAULT 0,
      supervisor_id             BIGINT,
      es_chofer                 INTEGER DEFAULT 0,
      licencia_numero           TEXT,
      licencia_fecha_emision    TEXT,
      licencia_organismo        TEXT,
      fecha_baja                TEXT,
      motivo_baja               TEXT,
      created_at                TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )
  `)
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_empleados_legajo ON empleados(legajo)`)

  // ─────────────────────────────────────────────────────────────────
  // BLOQUE 10 — CHOFERES, FLOTA Y AUXILIARES
  // ─────────────────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS documentos (
      id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      entidad_tipo      TEXT NOT NULL CHECK (entidad_tipo IN ('empleado','vehiculo')),
      entidad_id        BIGINT NOT NULL,
      tipo              TEXT NOT NULL,
      descripcion       TEXT DEFAULT '',
      archivo           TEXT,
      fecha_emision     TEXT,
      fecha_vencimiento TEXT,
      created_at        TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_documentos_entidad ON documentos(entidad_tipo, entidad_id)`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS control_horario (
      id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      id_empleado    BIGINT NOT NULL REFERENCES empleados(id),
      fecha          TEXT NOT NULL DEFAULT to_char(CURRENT_DATE, 'YYYY-MM-DD'),
      hora_ingreso   TEXT,
      hora_egreso    TEXT,
      horas_normales REAL DEFAULT 0,
      horas_extra    REAL DEFAULT 0,
      motivo_extra   TEXT DEFAULT '',
      aprobado       INTEGER DEFAULT 0,
      aprobado_por   BIGINT,
      observaciones  TEXT DEFAULT '',
      created_at     TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS pagos_empleado (
      id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      id_empleado BIGINT NOT NULL REFERENCES empleados(id),
      tipo        TEXT NOT NULL CHECK (tipo IN ('sueldo','anticipo','viatico','horas_extra','bonificacion','descuento','liquidacion')),
      periodo     TEXT,
      monto       REAL NOT NULL DEFAULT 0,
      fecha       TEXT NOT NULL DEFAULT to_char(CURRENT_DATE, 'YYYY-MM-DD'),
      descripcion TEXT DEFAULT '',
      created_at  TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS estado_vehiculo_hist (
      id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      id_vehiculo   BIGINT NOT NULL REFERENCES flota_vehiculos(id),
      estado        TEXT NOT NULL,
      fecha         TEXT NOT NULL DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
      id_usuario    BIGINT,
      observaciones TEXT DEFAULT ''
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS config_mantenimiento (
      id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      id_vehiculo BIGINT REFERENCES flota_vehiculos(id),
      tipo        TEXT NOT NULL,
      cada_km     INTEGER,
      cada_meses  INTEGER,
      descripcion TEXT DEFAULT '',
      created_at  TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS gastos_vehiculo (
      id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      id_vehiculo BIGINT NOT NULL REFERENCES flota_vehiculos(id),
      categoria   TEXT NOT NULL CHECK (categoria IN ('seguro','impuesto','peaje','estacionamiento','multa','otro')),
      descripcion TEXT DEFAULT '',
      monto       REAL NOT NULL DEFAULT 0,
      fecha       TEXT NOT NULL DEFAULT to_char(CURRENT_DATE, 'YYYY-MM-DD'),
      vencimiento TEXT,
      estado      TEXT DEFAULT 'pagado',
      archivo     TEXT,
      created_at  TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS rastreo_chofer (
      id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      id_op               BIGINT REFERENCES op_encabezado(id),
      id_empleado         BIGINT NOT NULL REFERENCES empleados(id),
      lat                 REAL,
      lng                 REAL,
      velocidad           REAL DEFAULT 0,
      exactitud           REAL,
      fecha_registro      TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_rastreo_op ON rastreo_chofer(id_op)`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_rastreo_empleado ON rastreo_chofer(id_empleado)`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_rastreo_fecha ON rastreo_chofer(fecha_registro DESC)`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS auditoria (
      id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      entidad_tipo TEXT NOT NULL,
      entidad_id   BIGINT NOT NULL,
      accion       TEXT NOT NULL,
      id_usuario   BIGINT,
      detalle      TEXT DEFAULT '',
      created_at   TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_auditoria_entidad ON auditoria(entidad_tipo, entidad_id)`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS config_notificaciones (
      id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      clave      TEXT NOT NULL UNIQUE,
      valor      TEXT NOT NULL DEFAULT '',
      created_at TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS asignaciones_recurso (
      id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      id_empleado   BIGINT NOT NULL REFERENCES empleados(id),
      recurso_tipo  TEXT NOT NULL CHECK (recurso_tipo IN ('camion','maquina')),
      recurso_id    BIGINT NOT NULL,
      fecha_desde   TEXT NOT NULL DEFAULT to_char(CURRENT_DATE, 'YYYY-MM-DD'),
      fecha_hasta   TEXT,
      activo        INTEGER DEFAULT 1,
      observaciones TEXT DEFAULT '',
      created_at    TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_asig_recurso  ON asignaciones_recurso(recurso_tipo, recurso_id, activo)`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_asig_empleado ON asignaciones_recurso(id_empleado, activo)`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS stock_ingresos (
      id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      id_producto    BIGINT NOT NULL REFERENCES productos(id),
      id_proveedor   BIGINT REFERENCES proveedores(id),
      cantidad       REAL NOT NULL,
      costo_unitario REAL DEFAULT 0,
      id_usuario     BIGINT,
      observaciones  TEXT DEFAULT '',
      fecha          TEXT NOT NULL DEFAULT to_char(CURRENT_DATE, 'YYYY-MM-DD'),
      created_at     TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )
  `)

  // ─────────────────────────────────────────────────────────────────
  // TABLAS DE CONFIGURACIÓN
  // ─────────────────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS config_contenedores (
      id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      clave       TEXT NOT NULL UNIQUE,
      valor       TEXT NOT NULL DEFAULT '',
      descripcion TEXT DEFAULT '',
      created_at  TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS config_maquinaria (
      id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      id_maquinaria BIGINT REFERENCES maquinaria(id),
      clave         TEXT NOT NULL,
      valor         TEXT NOT NULL DEFAULT '',
      created_at    TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
      UNIQUE(id_maquinaria, clave)
    )
  `)

  // ─────────────────────────────────────────────────────────────────
  // MEJORAS FUNCIONALES — columnas nuevas + historial de kilometraje
  // ─────────────────────────────────────────────────────────────────
  // Empleados: vencimiento de pago, especialización y anticipación de licencia
  await pool.query(`ALTER TABLE empleados ADD COLUMN IF NOT EXISTS fecha_vencimiento_pago TEXT`).catch(() => {})
  await pool.query(`ALTER TABLE empleados ADD COLUMN IF NOT EXISTS tipo_operacion TEXT`).catch(() => {})
  await pool.query(`ALTER TABLE empleados ADD COLUMN IF NOT EXISTS licencia_dias_alerta INTEGER DEFAULT 30`).catch(() => {})
  // Flota y maquinaria: actividad para la que está destinada la unidad
  await pool.query(`ALTER TABLE flota_vehiculos ADD COLUMN IF NOT EXISTS actividad TEXT`).catch(() => {})
  await pool.query(`ALTER TABLE maquinaria ADD COLUMN IF NOT EXISTS actividad TEXT`).catch(() => {})
  // Documentos: anticipación de la alerta configurable por documento
  await pool.query(`ALTER TABLE documentos ADD COLUMN IF NOT EXISTS dias_alerta INTEGER DEFAULT 30`).catch(() => {})
  // Zona del viaje (venta con flete) para tarifa y planificación logística
  await pool.query(`ALTER TABLE op_encabezado ADD COLUMN IF NOT EXISTS zona TEXT`).catch(() => {})
  // Hora planificada de la operación (para detectar solapamientos de camión/chofer)
  await pool.query(`ALTER TABLE op_encabezado ADD COLUMN IF NOT EXISTS hora_planificada TEXT`).catch(() => {})
  // Obra: nombre/referencia del destino cuando no hay una dirección de calle exacta
  await pool.query(`ALTER TABLE op_encabezado ADD COLUMN IF NOT EXISTS obra TEXT`).catch(() => {})
  // Cuenta corriente: método de pago del movimiento (para pagos / abonos)
  await pool.query(`ALTER TABLE movimientos_cuenta ADD COLUMN IF NOT EXISTS metodo_pago TEXT`).catch(() => {})
  // Unificación de actividades a 3 categorías: ventas / contenedores / maquinas
  const _mapAct = `CASE actividad
      WHEN 'camion_viajes' THEN 'ventas' WHEN 'camion_contenedores' THEN 'contenedores'
      WHEN 'maquina_deposito' THEN 'maquinas' WHEN 'maquina_alquiler' THEN 'maquinas'
      ELSE actividad END`
  await pool.query(`UPDATE flota_vehiculos SET actividad = ${_mapAct} WHERE actividad IN ('camion_viajes','camion_contenedores','maquina_deposito','maquina_alquiler')`).catch(() => {})
  await pool.query(`UPDATE maquinaria SET actividad = ${_mapAct} WHERE actividad IN ('camion_viajes','camion_contenedores','maquina_deposito','maquina_alquiler')`).catch(() => {})
  await pool.query(`UPDATE empleados SET tipo_operacion = CASE tipo_operacion
      WHEN 'camion_viajes' THEN 'ventas' WHEN 'camion_contenedores' THEN 'contenedores'
      WHEN 'maquina_deposito' THEN 'maquinas' WHEN 'maquina_alquiler' THEN 'maquinas'
      ELSE tipo_operacion END
    WHERE tipo_operacion IN ('camion_viajes','camion_contenedores','maquina_deposito','maquina_alquiler')`).catch(() => {})
  // Catálogo de zonas (con tarifa de flete configurable)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS zonas (
      id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      nombre       TEXT NOT NULL UNIQUE,
      tarifa_flete REAL DEFAULT 0,
      orden        INTEGER DEFAULT 0,
      activo       INTEGER DEFAULT 1,
      created_at   TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )
  `)
  // Seed de zonas estándar (si la tabla está vacía)
  for (const [nombre, orden] of [['Norte', 1], ['Sur', 2], ['Este', 3], ['Oeste', 4], ['Centro', 5]]) {
    await pool.query(`INSERT INTO zonas (nombre, orden) VALUES ($1, $2) ON CONFLICT (nombre) DO NOTHING`, [nombre, orden])
  }
  // Historial de kilometraje (auditoría de incrementos automáticos)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS historial_kilometraje (
      id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      id_vehiculo   BIGINT NOT NULL REFERENCES flota_vehiculos(id),
      id_op         BIGINT REFERENCES op_encabezado(id),
      km_anterior   INTEGER NOT NULL DEFAULT 0,
      km_nuevo      INTEGER NOT NULL DEFAULT 0,
      distancia     REAL DEFAULT 0,
      motivo        TEXT DEFAULT '',
      fecha         TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_histkm_vehiculo ON historial_kilometraje(id_vehiculo)`)

  // ─────────────────────────────────────────────────────────────────
  // SEEDS DE CONFIGURACIÓN
  // ─────────────────────────────────────────────────────────────────
  for (const [k, v] of [
    ['email_activo', '0'], ['email_destinatarios', ''], ['umbral_dias', '90,60,30'],
    ['alertas_licencias', '1'], ['alertas_documentos', '1'], ['alertas_mantenimiento', '1'],
  ]) {
    await pool.query(
      `INSERT INTO config_notificaciones (clave, valor) VALUES ($1, $2) ON CONFLICT (clave) DO NOTHING`,
      [k, v]
    )
  }

  for (const [clave, valor, desc] of [
    ['precio_dia', '30000', 'Precio por día de alquiler'],
    ['precio_alquiler', '250000', 'Precio base alquiler (9+ días)'],
    ['plazo_minimo', '4', 'Plazo mínimo en días'],
    ['plazo_maximo', '9', 'Plazo máximo en días'],
    ['tiempo_entre_alquileres', '0', 'Horas mínimas entre alquileres'],
    ['costo_extra_dia', '30000', 'Costo extra por día adicional'],
  ]) {
    await pool.query(
      `INSERT INTO config_contenedores (clave, valor, descripcion) VALUES ($1, $2, $3) ON CONFLICT (clave) DO NOTHING`,
      [clave, valor, desc]
    )
  }

  for (const [clave, valor] of [
    ['precio_por_hora_default', '15000'],
    ['precio_por_dia_default', '80000'],
    ['modo_precio_default', 'hora'],
  ]) {
    // id_maquinaria NULL = config global. ON CONFLICT no sirve con NULL
    // (NULL ≠ NULL), por eso se usa un guard explícito para no duplicar.
    await pool.query(
      `INSERT INTO config_maquinaria (id_maquinaria, clave, valor)
       SELECT NULL, $1, $2
       WHERE NOT EXISTS (SELECT 1 FROM config_maquinaria WHERE id_maquinaria IS NULL AND clave = $1)`,
      [clave, valor]
    )
  }

  // ─────────────────────────────────────────────────────────────────
  // BACKFILLS — numeración de registros sin número interno
  // ─────────────────────────────────────────────────────────────────
  for (const tabla of ['flota_vehiculos', 'maquinaria']) {
    const { rows: pend } = await pool.query(`SELECT id FROM ${tabla} WHERE numero_interno IS NULL ORDER BY created_at, id`)
    if (pend.length) {
      const { rows: [mr] } = await pool.query(`SELECT COALESCE(MAX(numero_interno), 0) AS m FROM ${tabla}`)
      let next = (parseInt(mr.m) || 0) + 1
      await transaction(async (q) => {
        for (const r of pend) {
          await q(`UPDATE ${tabla} SET numero_interno = ? WHERE id = ?`, [next++, r.id])
        }
      })
    }
  }

  // Backfill transacciones sin número
  const { rows: pendTx } = await pool.query(`SELECT id, tipo FROM transacciones WHERE numero IS NULL ORDER BY created_at, id`)
  if (pendTx.length) {
    const { rows: maxRows } = await pool.query(`SELECT tipo, COALESCE(MAX(numero), 0) AS m FROM transacciones WHERE numero IS NOT NULL GROUP BY tipo`)
    const maxPorTipo = {}
    maxRows.forEach(r => { maxPorTipo[r.tipo] = parseInt(r.m) })
    await transaction(async (q) => {
      for (const t of pendTx) {
        const n = (maxPorTipo[t.tipo] || 0) + 1
        maxPorTipo[t.tipo] = n
        await q(`UPDATE transacciones SET numero = ? WHERE id = ?`, [n, t.id])
      }
    })
  }

  // Backfill clientes sin número
  const { rows: pendCli } = await pool.query(`SELECT id FROM clientes WHERE numero IS NULL ORDER BY created_at, id`)
  if (pendCli.length) {
    const { rows: [maxCli] } = await pool.query(`SELECT COALESCE(MAX(numero), 0) AS m FROM clientes`)
    let next = (parseInt(maxCli.m) || 0) + 1
    await transaction(async (q) => {
      for (const c of pendCli) {
        await q(`UPDATE clientes SET numero = ? WHERE id = ?`, [next++, c.id])
      }
    })
  }

  // ─────────────────────────────────────────────────────────────────
  // SEED DE DESARROLLO
  // ─────────────────────────────────────────────────────────────────
  const seedUsuarios = [
    { usuario: 'eduardomezzavilla', nombre: 'Eduardo Mezzavilla', rol: 'dueno' },
  ]
  for (const u of seedUsuarios) {
    await pool.query(
      `INSERT INTO users (usuario, password_hash, nombre, rol) VALUES ($1,$2,$3,$4) ON CONFLICT (usuario) DO NOTHING`,
      [u.usuario, bcrypt.hashSync('suelosur123', 10), u.nombre, u.rol]
    )
  }

  // Productos
  const { rows: [{ n: cantProd }] } = await pool.query(`SELECT COUNT(*) AS n FROM productos`)
  if (parseInt(cantProd) === 0) {
    for (const [nombre, um, precio] of [
      ['Arena Fina', 'm³', 8500], ['Arena Gruesa', 'm³', 7800],
      ['Piedra Partida', 'm³', 9200], ['Piedra Bola', 'm³', 8800],
      ['Canto Rodado', 'm³', 10500], ['Tosca', 'm³', 5500],
    ]) {
      await pool.query(
        `INSERT INTO productos (nombre, unidad_medida, precio_referencia) VALUES ($1,$2,$3)`,
        [nombre, um, precio]
      )
    }
  }

  // Stock inicial
  const { rows: sinStock } = await pool.query(`
    SELECT p.id FROM productos p
    WHERE p.activo = 1
      AND NOT EXISTS (SELECT 1 FROM stock s WHERE s.id_producto = p.id)
  `)
  for (const p of sinStock) {
    await pool.query(
      `INSERT INTO stock (id_producto, cantidad_actual, cant_pendiente_entregar, stock_minimo) VALUES ($1,0,0,0)`,
      [p.id]
    )
  }

  // Nota: el catálogo operativo (clientes, proveedores, flota, contenedores,
  // maquinaria) se carga desde la app. No se siembran datos de ejemplo para
  // que el arranque sea limpio.

  // ─────────────────────────────────────────────────────────────────
  // Backfill: todo usuario con rol chofer debe tener un empleado vinculado.
  // Necesario para que el chofer pueda ver remitos/tareas de sus ops asignadas.
  // ─────────────────────────────────────────────────────────────────
  const choferesSinEmpleado = (await pool.query(`
    SELECT u.id, u.usuario, u.nombre
    FROM users u
    WHERE u.rol = 'chofer' AND u.activo = 1
      AND NOT EXISTS (SELECT 1 FROM empleados e WHERE e.id_usuario = u.id)
  `)).rows
  for (const u of choferesSinEmpleado) {
    const partes = String(u.nombre || u.usuario).trim().split(/\s+/)
    const nombre = partes[0] || u.usuario
    const apellido = partes.slice(1).join(' ') || ''
    const proxLegajo = (await pool.query(`SELECT COALESCE(MAX(legajo), 0) + 1 AS n FROM empleados`)).rows[0].n
    await pool.query(`
      INSERT INTO empleados (legajo, nombre, apellido, es_chofer, cargo, sector, id_usuario, estado_laboral, activo)
      VALUES ($1, $2, $3, 1, 'Chofer', 'Operaciones', $4, 'activo', 1)
    `, [proxLegajo, nombre, apellido, u.id])
    console.log(`  ↳ Empleado-chofer creado para usuario "${u.usuario}"`)
  }

  // ─────────────────────────────────────────────────────────────────
  // VISTAS LEGIBLES — para consultar en Supabase con nombres en vez de UUIDs.
  // No tocan los datos: son "tablas traducidas" de solo lectura.
  // ─────────────────────────────────────────────────────────────────
  await pool.query(`
    CREATE OR REPLACE VIEW v_stock AS
    SELECT p.nombre AS producto, p.unidad_medida AS unidad,
           s.cantidad_actual, s.cant_pendiente_entregar, s.stock_minimo,
           p.precio_referencia, s.id
    FROM stock s JOIN productos p ON p.id = s.id_producto
  `)
  await pool.query(`
    CREATE OR REPLACE VIEW v_operaciones AS
    SELECT op.nro_op, op.fecha_emision, op.tipo_op, op.estado, op.modalidad, op.metodo_pago,
           COALESCE(c.nombre, 'Particular') AS cliente, c.numero AS nro_cliente,
           NULLIF(TRIM(COALESCE(e.nombre, '') || ' ' || COALESCE(e.apellido, '')), '') AS chofer,
           fv.nombre AS camion, u.nombre AS administrativo, op.id
    FROM op_encabezado op
    LEFT JOIN clientes c        ON c.id  = op.id_cliente
    LEFT JOIN empleados e       ON e.id  = op.id_chofer
    LEFT JOIN flota_vehiculos fv ON fv.id = op.id_camion
    LEFT JOIN users u           ON u.id  = op.id_administrativo
  `)
  await pool.query(`
    CREATE OR REPLACE VIEW v_detalle_material AS
    SELECT op.nro_op, p.nombre AS producto, d.cantidad_pedida, p.unidad_medida AS unidad,
           d.precio_unitario, (d.cantidad_pedida * d.precio_unitario) AS subtotal, d.id
    FROM op_detalle_material d
    JOIN op_encabezado op ON op.id = d.id_orden_pedido
    JOIN productos p      ON p.id  = d.id_producto
  `)
  await pool.query(`
    CREATE OR REPLACE VIEW v_movimientos_contenedor AS
    SELECT m.fecha_movimiento, cont.numero_contenedor, m.estado_paso,
           u.nombre AS chofer, fv.nombre AS camion, m.observaciones, m.id
    FROM movimiento_contenedor m
    JOIN contenedores cont       ON cont.id = m.id_contenedor
    LEFT JOIN users u            ON u.id    = m.id_chofer
    LEFT JOIN flota_vehiculos fv ON fv.id   = m.id_camion
  `)
  await pool.query(`
    CREATE OR REPLACE VIEW v_movimientos_cuenta AS
    SELECT m.created_at AS fecha, cl.numero AS nro_cliente, cl.nombre AS cliente,
           m.tipo, m.descripcion, m.monto, m.id
    FROM movimientos_cuenta m JOIN clientes cl ON cl.id = m.cliente_id
  `)
  await pool.query(`
    CREATE OR REPLACE VIEW v_transacciones AS
    SELECT t.numero, t.tipo, t.fecha, COALESCE(cl.nombre, t.cliente) AS cliente,
           t.monto, t.metodo_pago, t.nro_remito, t.descripcion, t.id
    FROM transacciones t LEFT JOIN clientes cl ON cl.id = t.cliente_id
  `)

  // ─────────────────────────────────────────────────────────────────
  // MIGRACIÓN: nuevo workflow de estados de contenedor (2025-07)
  // Ampliar el CHECK constraint para incluir los estados nuevos Y los viejos
  // (así la migración no rompe si alguno queda en el medio).
  // ─────────────────────────────────────────────────────────────────
  await pool.query(`ALTER TABLE movimiento_contenedor DROP CONSTRAINT IF EXISTS movimiento_contenedor_estado_paso_check`).catch(() => {})
  await pool.query(`ALTER TABLE movimiento_contenedor ADD CONSTRAINT movimiento_contenedor_estado_paso_check CHECK (estado_paso IN ('disponible','pendiente_despacho','despachado','en_alquiler','pendiente_retiro','vuelta_a_planta','en_planta','en_transito','entregado','a_retirar','vaciado'))`).catch(() => {})

  // Renombrar estados viejos a nuevos
  await pool.query(`UPDATE movimiento_contenedor SET estado_paso = 'disponible' WHERE estado_paso IN ('en_planta','vaciado')`).catch(() => {})
  await pool.query(`UPDATE movimiento_contenedor SET estado_paso = 'pendiente_retiro' WHERE estado_paso = 'a_retirar'`).catch(() => {})
  await pool.query(`UPDATE movimiento_contenedor SET estado_paso = 'en_alquiler' WHERE estado_paso = 'entregado'`).catch(() => {})
  // en_transito al retirar contenedor → vuelta_a_planta
  await pool.query(`
    UPDATE movimiento_contenedor mc SET estado_paso = 'vuelta_a_planta'
    FROM op_detalle_contenedor oc JOIN op_encabezado op ON op.id = oc.id_orden_pedido
    WHERE mc.id_op_contenedor = oc.id AND mc.estado_paso = 'en_transito' AND op.estado = 'entregado'
  `).catch(() => {})
  // en_transito al entregar contenedor → despachado
  await pool.query(`
    UPDATE movimiento_contenedor mc SET estado_paso = 'despachado'
    FROM op_detalle_contenedor oc JOIN op_encabezado op ON op.id = oc.id_orden_pedido
    WHERE mc.id_op_contenedor = oc.id AND mc.estado_paso = 'en_transito' AND op.estado IN ('pendiente','despachado')
  `).catch(() => {})
  // cualquier en_transito restante → disponible (borde)
  await pool.query(`UPDATE movimiento_contenedor SET estado_paso = 'disponible' WHERE estado_paso = 'en_transito'`).catch(() => {})

  // Insertar pendiente_despacho para contenedores asignados a órdenes pendientes que quedaron en disponible
  await pool.query(`
    WITH ultimo AS (
      SELECT DISTINCT ON (id_contenedor) id_contenedor, estado_paso, id AS id_mov
      FROM movimiento_contenedor ORDER BY id_contenedor, fecha_movimiento DESC, id DESC
    )
    INSERT INTO movimiento_contenedor (id_contenedor, id_op_contenedor, estado_paso, observaciones)
    SELECT oc.id_contenedor, oc.id, 'pendiente_despacho', 'Migración: reservado para despacho'
    FROM op_detalle_contenedor oc
    JOIN op_encabezado op ON op.id = oc.id_orden_pedido
    JOIN ultimo u ON u.id_contenedor = oc.id_contenedor
    WHERE op.estado = 'pendiente' AND oc.id_contenedor IS NOT NULL
      AND u.estado_paso = 'disponible' AND op.tipo_op = 'C'
      AND NOT EXISTS (
        SELECT 1 FROM movimiento_contenedor mc2
        WHERE mc2.id_contenedor = oc.id_contenedor AND mc2.id_op_contenedor = oc.id AND mc2.estado_paso = 'pendiente_despacho'
      )
  `).catch(() => {})

  // Ahora estrechar el CHECK a solo los nuevos estados
  await pool.query(`ALTER TABLE movimiento_contenedor DROP CONSTRAINT IF EXISTS movimiento_contenedor_estado_paso_check`).catch(() => {})
  await pool.query(`ALTER TABLE movimiento_contenedor ADD CONSTRAINT movimiento_contenedor_estado_paso_check CHECK (estado_paso IN ('disponible','pendiente_despacho','despachado','en_alquiler','pendiente_retiro','vuelta_a_planta'))`).catch(() => {})

  // MIGRACIÓN: remito de retiro (los alquileres de contenedor tienen 2 remitos:
  // el de entrega y el de retiro, cada uno con su firma y su foto).
  await pool.query(`ALTER TABLE op_encabezado ADD COLUMN IF NOT EXISTS firma_retiro TEXT`).catch(() => {})
  await pool.query(`ALTER TABLE op_encabezado ADD COLUMN IF NOT EXISTS firma_retiro_aclaracion TEXT`).catch(() => {})
  await pool.query(`ALTER TABLE op_encabezado ADD COLUMN IF NOT EXISTS archivo_remito_retiro TEXT`).catch(() => {})

  console.log('✅ Base de datos PostgreSQL inicializada')
}

// Borra el rastreo GPS de los choferes con más de N días (default 7).
// Conserva la última semana y evita que la tabla crezca indefinidamente.
// LEFT(fecha_registro, 10) toma 'YYYY-MM-DD' (funciona con ambos formatos guardados).
async function limpiarRastreoViejo(dias = 7) {
  try {
    const r = await pool.query(
      `DELETE FROM rastreo_chofer WHERE LEFT(fecha_registro, 10)::date < CURRENT_DATE - $1::int`,
      [dias]
    )
    if (r.rowCount > 0) console.log(`🧹 Rastreo GPS: ${r.rowCount} registro(s) de más de ${dias} días eliminados`)
    return r.rowCount
  } catch (e) {
    console.error('Error al limpiar el rastreo GPS:', e.message)
    return 0
  }
}

module.exports = { pool, query, transaction, initDB, limpiarRastreoViejo }
