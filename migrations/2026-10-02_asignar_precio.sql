-- Alquileres de contenedor sin precio: los nuevos se cargan con precio_alquiler NULL y el
-- precio y el método de pago se asignan en Cobranzas → Asignar precio. Se aplica sola al
-- arrancar la app (initDB en src/config/db.js); este archivo es para correrla a mano en el
-- SQL Editor de Supabase si hace falta. Idempotente. No modifica datos existentes.

-- Cuándo se asignó el precio ('YYYY-MM-DD HH24:MI:SS', hora local). Un precio asignado es lo
-- que se cobra al retirar el contenedor; NULL = precio cargado al dar de alta el alquiler
-- (los alquileres ya existentes), que al retirar se cobra por días como siempre.
ALTER TABLE op_detalle_contenedor ADD COLUMN IF NOT EXISTS precio_asignado_en TEXT;
