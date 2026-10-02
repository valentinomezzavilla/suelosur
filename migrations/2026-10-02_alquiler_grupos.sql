-- Alquileres con varios contenedores: un alquiler agrupado es un grupo de operaciones
-- (una por contenedor). Se aplica sola al arrancar la app (initDB en src/config/db.js);
-- este archivo es para correrla a mano en el SQL Editor de Supabase si hace falta.
-- Idempotente. Requiere la función ahora_local() (migración de hora local).

CREATE TABLE IF NOT EXISTS alquiler_grupos (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- 'contenedor': cada OP se cobra al retirarla. 'alquiler': todo junto al retirar la última.
  cobro_modo TEXT NOT NULL DEFAULT 'contenedor' CHECK (cobro_modo IN ('contenedor', 'alquiler')),
  created_at TEXT DEFAULT ahora_local()
);

-- NULL = alquiler de un solo contenedor (como siempre).
ALTER TABLE op_encabezado ADD COLUMN IF NOT EXISTS id_grupo BIGINT REFERENCES alquiler_grupos(id);
CREATE INDEX IF NOT EXISTS idx_op_encabezado_id_grupo ON op_encabezado (id_grupo) WHERE id_grupo IS NOT NULL;
