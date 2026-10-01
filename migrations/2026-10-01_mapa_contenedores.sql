-- Mapa de contenedores: coordenadas de la dirección de entrega de cada alquiler.
-- Se aplica sola al arrancar la app (initDB en src/config/db.js); este archivo es
-- para correrla a mano en el SQL Editor de Supabase si hace falta. Idempotente.

-- Las columnas de coordenadas ya existían como REAL (float4) y sin uso: se pasan a
-- DOUBLE PRECISION porque con float4 vuelven redondeadas a ~10-15 m.
ALTER TABLE op_detalle_contenedor ADD COLUMN IF NOT EXISTS domicilio_lat      DOUBLE PRECISION;
ALTER TABLE op_detalle_contenedor ADD COLUMN IF NOT EXISTS domicilio_lng      DOUBLE PRECISION;
ALTER TABLE op_detalle_contenedor ALTER COLUMN domicilio_lat TYPE DOUBLE PRECISION;
ALTER TABLE op_detalle_contenedor ALTER COLUMN domicilio_lng TYPE DOUBLE PRECISION;

-- Resultado de la geocodificación:
--   ubicado:    'ok' (exacta) | 'cruce' (esquina) | 'calle' / 'barrio' (aproximadas) | 'manual'
--   sin ubicar: 'sin_resultado' | 'ambigua' | 'sin_direccion' | 'error'
--   NULL = todavía no se intentó (lo toma el script de backfill).
-- geo_detalle: qué se encontró (ej. "Barrio Docta (centro aproximado)").
ALTER TABLE op_detalle_contenedor ADD COLUMN IF NOT EXISTS geo_estado         TEXT;
ALTER TABLE op_detalle_contenedor ADD COLUMN IF NOT EXISTS geo_actualizado_en TEXT;
ALTER TABLE op_detalle_contenedor ADD COLUMN IF NOT EXISTS geo_detalle        TEXT;
