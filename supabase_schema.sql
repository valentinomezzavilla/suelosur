-- ═══════════════════════════════════════════════════════════════════
-- supabase_schema.sql — Esquema completo · Suelosur S.A.S.
-- Para ejecutar en el SQL Editor de Supabase.
--
-- ⚠️  ATENCIÓN: la PARTE 1 ELIMINA TODAS LAS TABLAS Y SUS DATOS.
--     No hay vuelta atrás. Hacé un backup antes si hay datos que importan.
--
-- El script es equivalente al initDB() de src/config/db.js, con las
-- migraciones (ALTER TABLE) ya incorporadas en los CREATE TABLE.
-- ═══════════════════════════════════════════════════════════════════


-- ═══════════════════════════════════════════════════════════════════
-- PARTE 1 — ELIMINAR TODO
-- ═══════════════════════════════════════════════════════════════════

DROP VIEW IF EXISTS v_stock                  CASCADE;
DROP VIEW IF EXISTS v_operaciones            CASCADE;
DROP VIEW IF EXISTS v_detalle_material       CASCADE;
DROP VIEW IF EXISTS v_movimientos_contenedor CASCADE;
DROP VIEW IF EXISTS v_movimientos_cuenta     CASCADE;
DROP VIEW IF EXISTS v_transacciones          CASCADE;

DROP TABLE IF EXISTS historial_kilometraje   CASCADE;
DROP TABLE IF EXISTS zonas                   CASCADE;
DROP TABLE IF EXISTS config_maquinaria       CASCADE;
DROP TABLE IF EXISTS config_contenedores     CASCADE;
DROP TABLE IF EXISTS stock_ingresos          CASCADE;
DROP TABLE IF EXISTS asignaciones_recurso    CASCADE;
DROP TABLE IF EXISTS config_notificaciones   CASCADE;
DROP TABLE IF EXISTS auditoria               CASCADE;
DROP TABLE IF EXISTS rastreo_chofer          CASCADE;
DROP TABLE IF EXISTS gastos_vehiculo         CASCADE;
DROP TABLE IF EXISTS config_mantenimiento    CASCADE;
DROP TABLE IF EXISTS estado_vehiculo_hist    CASCADE;
DROP TABLE IF EXISTS pagos_empleado          CASCADE;
DROP TABLE IF EXISTS control_horario         CASCADE;
DROP TABLE IF EXISTS documentos              CASCADE;
DROP TABLE IF EXISTS empleados               CASCADE;
DROP TABLE IF EXISTS combustible             CASCADE;
DROP TABLE IF EXISTS mantenimiento_vehiculo  CASCADE;
DROP TABLE IF EXISTS cc_proveedores          CASCADE;
DROP TABLE IF EXISTS compras_detalle         CASCADE;
DROP TABLE IF EXISTS compras_encabezado      CASCADE;
DROP TABLE IF EXISTS proveedores             CASCADE;
DROP TABLE IF EXISTS circuito_paradas        CASCADE;
DROP TABLE IF EXISTS circuitos               CASCADE;
DROP TABLE IF EXISTS transacciones           CASCADE;
DROP TABLE IF EXISTS mantenimiento_maquinaria CASCADE;
DROP TABLE IF EXISTS movimiento_maquinaria   CASCADE;
DROP TABLE IF EXISTS movimiento_contenedor   CASCADE;
DROP TABLE IF EXISTS op_detalle_maquinaria   CASCADE;
DROP TABLE IF EXISTS op_detalle_contenedor   CASCADE;
DROP TABLE IF EXISTS maquinaria              CASCADE;
DROP TABLE IF EXISTS contenedores            CASCADE;
DROP TABLE IF EXISTS op_detalle_material     CASCADE;
DROP TABLE IF EXISTS op_encabezado           CASCADE;
DROP TABLE IF EXISTS flota_vehiculos         CASCADE;
DROP TABLE IF EXISTS stock                   CASCADE;
DROP TABLE IF EXISTS productos               CASCADE;
DROP TABLE IF EXISTS movimientos_cuenta      CASCADE;
DROP TABLE IF EXISTS clientes                CASCADE;
DROP TABLE IF EXISTS users                   CASCADE;


-- ═══════════════════════════════════════════════════════════════════
-- PARTE 2 — TABLAS CENTRALES
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE users (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  usuario       TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  nombre        TEXT NOT NULL,
  rol           TEXT NOT NULL CHECK (rol IN ('admin_ventas','admin_contable','chofer','dueno')),
  activo        INTEGER DEFAULT 1,
  created_at    TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE clientes (
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
);
CREATE UNIQUE INDEX idx_clientes_numero ON clientes(numero);

CREATE TABLE movimientos_cuenta (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  cliente_id  BIGINT NOT NULL REFERENCES clientes(id),
  tipo        TEXT NOT NULL CHECK (tipo IN ('deuda','pago','ajuste')),
  descripcion TEXT NOT NULL DEFAULT '',
  monto       REAL NOT NULL,
  created_at  TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE productos (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  nombre            TEXT NOT NULL,
  unidad_medida     TEXT NOT NULL DEFAULT 'm³',
  precio_referencia REAL DEFAULT 0,
  activo            INTEGER DEFAULT 1,
  created_at        TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE stock (
  id                      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id_producto             BIGINT NOT NULL UNIQUE REFERENCES productos(id),
  cantidad_actual         REAL DEFAULT 0,
  cant_pendiente_entregar REAL DEFAULT 0,
  stock_minimo            REAL DEFAULT 0
);

CREATE TABLE flota_vehiculos (
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
  actividad        TEXT,
  created_at       TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);


-- ═══════════════════════════════════════════════════════════════════
-- PARTE 3 — OPERACIONES
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE op_encabezado (
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
  zona                      TEXT,
  hora_planificada          TEXT,
  created_at                TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE op_detalle_material (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id_orden_pedido BIGINT NOT NULL REFERENCES op_encabezado(id),
  id_producto     BIGINT NOT NULL REFERENCES productos(id),
  cantidad_pedida REAL NOT NULL,
  precio_unitario REAL NOT NULL
);

-- Catálogos referenciados por op_detalle_*: deben crearse ANTES
CREATE TABLE contenedores (
  id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  numero_contenedor    INTEGER NOT NULL UNIQUE,
  estado_general       TEXT NOT NULL DEFAULT 'operativo'
                         CHECK (estado_general IN ('operativo','en_reparacion','baja')),
  fecha_ultima_pintada TEXT,
  observaciones        TEXT DEFAULT '',
  activo               INTEGER DEFAULT 1,
  created_at           TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE maquinaria (
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
  actividad       TEXT,
  created_at      TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE op_detalle_contenedor (
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
);

CREATE TABLE op_detalle_maquinaria (
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
);


-- ═══════════════════════════════════════════════════════════════════
-- PARTE 4 — MOVIMIENTOS DE CONTENEDORES Y MAQUINARIA
-- ═══════════════════════════════════════════════════════════════════

-- CHECK ya con los estados finales del workflow 2025-07
CREATE TABLE movimiento_contenedor (
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
);

CREATE TABLE movimiento_maquinaria (
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
);

CREATE TABLE mantenimiento_maquinaria (
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
);


-- ═══════════════════════════════════════════════════════════════════
-- PARTE 5 — TRANSACCIONES
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE transacciones (
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
);


-- ═══════════════════════════════════════════════════════════════════
-- PARTE 6 — CIRCUITOS LOGÍSTICOS
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE circuitos (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  fecha         TEXT NOT NULL DEFAULT to_char(CURRENT_DATE, 'YYYY-MM-DD'),
  id_chofer     BIGINT REFERENCES users(id),
  id_camion     BIGINT REFERENCES flota_vehiculos(id),
  id_empleado   BIGINT,
  estado        TEXT NOT NULL DEFAULT 'borrador'
                  CHECK (estado IN ('borrador','confirmado','en_curso','finalizado')),
  observaciones TEXT DEFAULT '',
  created_at    TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE circuito_paradas (
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
);


-- ═══════════════════════════════════════════════════════════════════
-- PARTE 7 — COMPRAS Y PROVEEDORES
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE proveedores (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  nombre     TEXT NOT NULL,
  cuit       TEXT,
  domicilio  TEXT,
  telefono   TEXT,
  email      TEXT,
  activo     INTEGER DEFAULT 1,
  created_at TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE compras_encabezado (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id_proveedor  BIGINT NOT NULL REFERENCES proveedores(id),
  fecha         TEXT NOT NULL DEFAULT to_char(CURRENT_DATE, 'YYYY-MM-DD'),
  estado        TEXT NOT NULL DEFAULT 'emitida'
                  CHECK (estado IN ('emitida','recibida','cancelada')),
  observaciones TEXT DEFAULT '',
  created_at    TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE compras_detalle (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id_compra       BIGINT NOT NULL REFERENCES compras_encabezado(id),
  id_producto     BIGINT NOT NULL REFERENCES productos(id),
  cantidad        REAL NOT NULL,
  precio_unitario REAL NOT NULL
);

CREATE TABLE cc_proveedores (
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
);


-- ═══════════════════════════════════════════════════════════════════
-- PARTE 8 — FLOTA Y MANTENIMIENTO
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE mantenimiento_vehiculo (
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
);

CREATE TABLE combustible (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id_vehiculo  BIGINT NOT NULL REFERENCES flota_vehiculos(id),
  id_chofer    BIGINT REFERENCES users(id),
  litros       REAL NOT NULL,
  costo_total  REAL NOT NULL,
  km_al_cargar INTEGER DEFAULT 0,
  fecha        TEXT NOT NULL DEFAULT to_char(CURRENT_DATE, 'YYYY-MM-DD'),
  estacion     TEXT,
  created_at   TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);


-- ═══════════════════════════════════════════════════════════════════
-- PARTE 9 — PERSONAL (RRHH)
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE empleados (
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
  fecha_vencimiento_pago    TEXT,
  tipo_operacion            TEXT,
  licencia_dias_alerta      INTEGER DEFAULT 30,
  created_at                TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
CREATE UNIQUE INDEX idx_empleados_legajo ON empleados(legajo);


-- ═══════════════════════════════════════════════════════════════════
-- PARTE 10 — AUXILIARES
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE documentos (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entidad_tipo      TEXT NOT NULL CHECK (entidad_tipo IN ('empleado','vehiculo')),
  entidad_id        BIGINT NOT NULL,
  tipo              TEXT NOT NULL,
  descripcion       TEXT DEFAULT '',
  archivo           TEXT,
  fecha_emision     TEXT,
  fecha_vencimiento TEXT,
  dias_alerta       INTEGER DEFAULT 30,
  created_at        TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX idx_documentos_entidad ON documentos(entidad_tipo, entidad_id);

CREATE TABLE control_horario (
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
);

CREATE TABLE pagos_empleado (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id_empleado BIGINT NOT NULL REFERENCES empleados(id),
  tipo        TEXT NOT NULL CHECK (tipo IN ('sueldo','anticipo','viatico','horas_extra','bonificacion','descuento','liquidacion')),
  periodo     TEXT,
  monto       REAL NOT NULL DEFAULT 0,
  fecha       TEXT NOT NULL DEFAULT to_char(CURRENT_DATE, 'YYYY-MM-DD'),
  descripcion TEXT DEFAULT '',
  created_at  TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE estado_vehiculo_hist (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id_vehiculo   BIGINT NOT NULL REFERENCES flota_vehiculos(id),
  estado        TEXT NOT NULL,
  fecha         TEXT NOT NULL DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  id_usuario    BIGINT,
  observaciones TEXT DEFAULT ''
);

CREATE TABLE config_mantenimiento (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id_vehiculo BIGINT REFERENCES flota_vehiculos(id),
  tipo        TEXT NOT NULL,
  cada_km     INTEGER,
  cada_meses  INTEGER,
  descripcion TEXT DEFAULT '',
  created_at  TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE gastos_vehiculo (
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
);

CREATE TABLE rastreo_chofer (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id_op          BIGINT REFERENCES op_encabezado(id),
  id_empleado    BIGINT NOT NULL REFERENCES empleados(id),
  lat            REAL,
  lng            REAL,
  velocidad      REAL DEFAULT 0,
  exactitud      REAL,
  fecha_registro TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX idx_rastreo_op       ON rastreo_chofer(id_op);
CREATE INDEX idx_rastreo_empleado ON rastreo_chofer(id_empleado);
CREATE INDEX idx_rastreo_fecha    ON rastreo_chofer(fecha_registro DESC);

CREATE TABLE auditoria (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entidad_tipo TEXT NOT NULL,
  entidad_id   BIGINT NOT NULL,
  accion       TEXT NOT NULL,
  id_usuario   BIGINT,
  detalle      TEXT DEFAULT '',
  created_at   TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX idx_auditoria_entidad ON auditoria(entidad_tipo, entidad_id);

CREATE TABLE config_notificaciones (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  clave      TEXT NOT NULL UNIQUE,
  valor      TEXT NOT NULL DEFAULT '',
  created_at TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE asignaciones_recurso (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id_empleado   BIGINT NOT NULL REFERENCES empleados(id),
  recurso_tipo  TEXT NOT NULL CHECK (recurso_tipo IN ('camion','maquina')),
  recurso_id    BIGINT NOT NULL,
  fecha_desde   TEXT NOT NULL DEFAULT to_char(CURRENT_DATE, 'YYYY-MM-DD'),
  fecha_hasta   TEXT,
  activo        INTEGER DEFAULT 1,
  observaciones TEXT DEFAULT '',
  created_at    TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX idx_asig_recurso  ON asignaciones_recurso(recurso_tipo, recurso_id, activo);
CREATE INDEX idx_asig_empleado ON asignaciones_recurso(id_empleado, activo);

CREATE TABLE stock_ingresos (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id_producto    BIGINT NOT NULL REFERENCES productos(id),
  id_proveedor   BIGINT REFERENCES proveedores(id),
  cantidad       REAL NOT NULL,
  costo_unitario REAL DEFAULT 0,
  id_usuario     BIGINT,
  observaciones  TEXT DEFAULT '',
  fecha          TEXT NOT NULL DEFAULT to_char(CURRENT_DATE, 'YYYY-MM-DD'),
  created_at     TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);


-- ═══════════════════════════════════════════════════════════════════
-- PARTE 11 — CONFIGURACIÓN Y CATÁLOGOS
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE config_contenedores (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  clave       TEXT NOT NULL UNIQUE,
  valor       TEXT NOT NULL DEFAULT '',
  descripcion TEXT DEFAULT '',
  created_at  TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE config_maquinaria (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id_maquinaria BIGINT REFERENCES maquinaria(id),
  clave         TEXT NOT NULL,
  valor         TEXT NOT NULL DEFAULT '',
  created_at    TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE(id_maquinaria, clave)
);

CREATE TABLE zonas (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  nombre       TEXT NOT NULL UNIQUE,
  tarifa_flete REAL DEFAULT 0,
  orden        INTEGER DEFAULT 0,
  activo       INTEGER DEFAULT 1,
  created_at   TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE historial_kilometraje (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id_vehiculo   BIGINT NOT NULL REFERENCES flota_vehiculos(id),
  id_op         BIGINT REFERENCES op_encabezado(id),
  km_anterior   INTEGER NOT NULL DEFAULT 0,
  km_nuevo      INTEGER NOT NULL DEFAULT 0,
  distancia     REAL DEFAULT 0,
  motivo        TEXT DEFAULT '',
  fecha         TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX idx_histkm_vehiculo ON historial_kilometraje(id_vehiculo);


-- ═══════════════════════════════════════════════════════════════════
-- PARTE 12 — VISTAS LEGIBLES (solo lectura, para consultar en Supabase)
-- ═══════════════════════════════════════════════════════════════════

CREATE OR REPLACE VIEW v_stock AS
SELECT p.nombre AS producto, p.unidad_medida AS unidad,
       s.cantidad_actual, s.cant_pendiente_entregar, s.stock_minimo,
       p.precio_referencia, s.id
FROM stock s JOIN productos p ON p.id = s.id_producto;

CREATE OR REPLACE VIEW v_operaciones AS
SELECT op.nro_op, op.fecha_emision, op.tipo_op, op.estado, op.modalidad, op.metodo_pago,
       COALESCE(c.nombre, 'Particular') AS cliente, c.numero AS nro_cliente,
       NULLIF(TRIM(COALESCE(e.nombre, '') || ' ' || COALESCE(e.apellido, '')), '') AS chofer,
       fv.nombre AS camion, u.nombre AS administrativo, op.id
FROM op_encabezado op
LEFT JOIN clientes c         ON c.id  = op.id_cliente
LEFT JOIN empleados e        ON e.id  = op.id_chofer
LEFT JOIN flota_vehiculos fv ON fv.id = op.id_camion
LEFT JOIN users u            ON u.id  = op.id_administrativo;

CREATE OR REPLACE VIEW v_detalle_material AS
SELECT op.nro_op, p.nombre AS producto, d.cantidad_pedida, p.unidad_medida AS unidad,
       d.precio_unitario, (d.cantidad_pedida * d.precio_unitario) AS subtotal, d.id
FROM op_detalle_material d
JOIN op_encabezado op ON op.id = d.id_orden_pedido
JOIN productos p      ON p.id  = d.id_producto;

CREATE OR REPLACE VIEW v_movimientos_contenedor AS
SELECT m.fecha_movimiento, cont.numero_contenedor, m.estado_paso,
       u.nombre AS chofer, fv.nombre AS camion, m.observaciones, m.id
FROM movimiento_contenedor m
JOIN contenedores cont       ON cont.id = m.id_contenedor
LEFT JOIN users u            ON u.id    = m.id_chofer
LEFT JOIN flota_vehiculos fv ON fv.id   = m.id_camion;

CREATE OR REPLACE VIEW v_movimientos_cuenta AS
SELECT m.created_at AS fecha, cl.numero AS nro_cliente, cl.nombre AS cliente,
       m.tipo, m.descripcion, m.monto, m.id
FROM movimientos_cuenta m JOIN clientes cl ON cl.id = m.cliente_id;

CREATE OR REPLACE VIEW v_transacciones AS
SELECT t.numero, t.tipo, t.fecha, COALESCE(cl.nombre, t.cliente) AS cliente,
       t.monto, t.metodo_pago, t.nro_remito, t.descripcion, t.id
FROM transacciones t LEFT JOIN clientes cl ON cl.id = t.cliente_id;


-- ═══════════════════════════════════════════════════════════════════
-- PARTE 13 — SEEDS
-- ═══════════════════════════════════════════════════════════════════

-- Usuarios iniciales (contraseña: suelosur123)
INSERT INTO users (usuario, password_hash, nombre, rol) VALUES
  ('valentino',      '$2a$10$HQhU2wILdH2/kEqjbh49VuqfWsxXnqGMFOqmycCC0tty64vDPWQaO', 'Valentino Mezzavilla', 'dueno'),
  ('admin_ventas',   '$2a$10$HQhU2wILdH2/kEqjbh49VuqfWsxXnqGMFOqmycCC0tty64vDPWQaO', 'Admin Ventas',         'admin_ventas'),
  ('admin_contable', '$2a$10$HQhU2wILdH2/kEqjbh49VuqfWsxXnqGMFOqmycCC0tty64vDPWQaO', 'Admin Contable',       'admin_contable'),
  ('chofer1',        '$2a$10$HQhU2wILdH2/kEqjbh49VuqfWsxXnqGMFOqmycCC0tty64vDPWQaO', 'Chofer Demo',          'chofer')
ON CONFLICT (usuario) DO NOTHING;

-- Todo usuario chofer necesita su empleado vinculado (para remitos/tareas)
INSERT INTO empleados (legajo, nombre, apellido, es_chofer, cargo, sector, id_usuario, estado_laboral, activo)
SELECT 1, 'Chofer', 'Demo', 1, 'Chofer', 'Operaciones', u.id, 'activo', 1
FROM users u WHERE u.usuario = 'chofer1'
ON CONFLICT (legajo) DO NOTHING;

-- Zonas estándar
INSERT INTO zonas (nombre, orden) VALUES
  ('Norte', 1), ('Sur', 2), ('Este', 3), ('Oeste', 4), ('Centro', 5)
ON CONFLICT (nombre) DO NOTHING;

-- Configuración de notificaciones
INSERT INTO config_notificaciones (clave, valor) VALUES
  ('email_activo', '0'),
  ('email_destinatarios', ''),
  ('umbral_dias', '90,60,30'),
  ('alertas_licencias', '1'),
  ('alertas_documentos', '1'),
  ('alertas_mantenimiento', '1')
ON CONFLICT (clave) DO NOTHING;

-- Configuración de contenedores
INSERT INTO config_contenedores (clave, valor, descripcion) VALUES
  ('precio_dia',              '30000',  'Precio por día de alquiler'),
  ('precio_alquiler',         '250000', 'Precio base alquiler (9+ días)'),
  ('plazo_minimo',            '4',      'Plazo mínimo en días'),
  ('plazo_maximo',            '9',      'Plazo máximo en días'),
  ('tiempo_entre_alquileres', '0',      'Horas mínimas entre alquileres'),
  ('costo_extra_dia',         '30000',  'Costo extra por día adicional')
ON CONFLICT (clave) DO NOTHING;

-- Configuración global de maquinaria (id_maquinaria NULL = global)
INSERT INTO config_maquinaria (id_maquinaria, clave, valor) VALUES
  (NULL, 'precio_por_hora_default', '15000'),
  (NULL, 'precio_por_dia_default',  '80000'),
  (NULL, 'modo_precio_default',     'hora');

-- Productos iniciales
INSERT INTO productos (nombre, unidad_medida, precio_referencia) VALUES
  ('Arena Fina',     'm³', 8500),
  ('Arena Gruesa',   'm³', 7800),
  ('Piedra Partida', 'm³', 9200),
  ('Piedra Bola',    'm³', 8800),
  ('Canto Rodado',   'm³', 10500),
  ('Tosca',          'm³', 5500);

-- Stock inicial en cero para cada producto
INSERT INTO stock (id_producto, cantidad_actual, cant_pendiente_entregar, stock_minimo)
SELECT p.id, 0, 0, 0 FROM productos p
WHERE p.activo = 1
  AND NOT EXISTS (SELECT 1 FROM stock s WHERE s.id_producto = p.id);


-- ═══════════════════════════════════════════════════════════════════
-- OPCIONAL — Habilitar RLS (Row Level Security)
-- La app se conecta por DATABASE_URL como dueña de las tablas, así que
-- habilitar RLS NO la afecta, pero bloquea el acceso anónimo por la
-- API REST automática de Supabase (PostgREST). Descomentá si querés.
-- ═══════════════════════════════════════════════════════════════════
-- DO $$
-- DECLARE t RECORD;
-- BEGIN
--   FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
--     EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.tablename);
--   END LOOP;
-- END $$;
