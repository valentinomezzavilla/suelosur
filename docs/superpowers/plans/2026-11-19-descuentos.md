# Descuentos a clientes — Plan de implementación

> **Para quien ejecute:** superpowers:executing-plans (ejecución en la misma sesión, pedida por el usuario: "mandale todo"). Pasos con casillas.

**Objetivo:** descuentos por % o monto fijo desde Liquidaciones y Cuenta corriente, que bajan lo que debe el cliente, con "Ver descuentos aplicados" y revertir.

**Arquitectura:** tablas `descuentos` + `descuento_operaciones`. Lógica pura en `src/utils/descuentos.js` (elegibles, reparto). `src/models/descuentos.model.js` arma opciones, vista previa, aplica (ajuste a favor por OP en cuenta corriente; nada en contado) y revierte (anula ajustes). `armar()` de Liquidaciones agrega un renglón negativo por descuento vigente.

**Tecnología:** Node/Express, EJS, PostgreSQL (pruebas con PGlite), `node:test`, pdfkit.

**Diseño:** `docs/superpowers/specs/2026-11-19-descuentos-design.md` (aprobado).

## Restricciones globales

- Textos en español rioplatense. Roles: `dueno`, `admin_contable`.
- Aviso exacto: `Tiene factura emitida (N° X): el descuento requiere una nota de crédito por fuera del sistema.` (sin N°: `Tiene factura emitida: …`).
- Descripción del ajuste: `Descuento 10% — OP-0123` / `Descuento $ 50.000 — OP-0123` / `Descuento 10% sobre el saldo`.
- Renglón: `Descuento 10% (19/11/2026)` / `Descuento $ 50.000 (19/11/2026)`.
- Tablas en `initDB` con `CREATE TABLE IF NOT EXISTS` (aditivas). Nunca con nodemon corriendo.
- Porcentaje: 0 < v ≤ 100. Monto: > 0 y ≤ lo que deben las alcanzadas (o el saldo total).

## Revisar en especial

1. Operación a CC con pago parcial: descontar no debe generar saldo a favor ni "Diferencia con lo cargado". → Tarea 2.
2. Revertir después de cobrar una de contado con el importe descontado: queda parcial por la diferencia. → Tarea 2.
3. Vista previa que cambió entre abrir el modal y aplicar (alguien cobró): se rechaza. → Tarea 2 (aplicar recalcula y compara `total`).
4. Revertir dos veces / revertir un descuento de otro cliente: error claro, sin cambios. → Tarea 2.
5. Alcance remito con operaciones fuera del período en pantalla: entran igual. → Tarea 2.

---

### Tarea 1: lógica pura (`src/utils/descuentos.js`)

**Produce:** `validar({ tipo, valor, alcance, referencia })` → `{ error } | { tipo, valor, alcance, referencia }`;
`esDescontable(op)` → bool; `repartir(ops, { tipo, valor })` → `[{ id, resta, monto, queda }]` (monto ≤ resta,
proporcional, redondeo al último); `montoSobre(base, { tipo, valor })`; `etiqueta({ tipo, valor })` → `10%` / `$ 50.000`;
`AVISO_FACTURA(nro)`.

- [ ] Pruebas `tests/descuentos.test.js`: 10% de [1000, 500] → [100, 50]; monto 100 sobre [200, 100] → [66.67, 33.33]; monto > Σ resta → error de `validar`/`repartir`; % 0 o 101 → error; excluye `estimado`, `enCurso`, `grupoTodoJunto`, sin entregar, a convenir, resta 0.
- [ ] Implementar, correr, commit.

### Tarea 2: tablas, modelo e integración en Liquidaciones

**Consume:** Tarea 1. **Produce:** `DescuentosModel.opciones(clienteId, filtros)` → `{ enPantalla, remitos, facturas, saldoTotal }`;
`vistaPrevia(clienteId, pedido, filtros)` → `{ lineas, total, avisos }`; `aplicar(clienteId, pedido, filtros, { usuario, motivo, totalEsperado })` → id;
`revertir(id, clienteId, { usuario, motivo })`; `delCliente(clienteId)` → lista con operaciones; `vigentesPorOperacion(ids)` → `{ [idOp]: [{ etiqueta, fecha, monto }] }`.

- [ ] Pruebas `tests/descuentos-modelo.test.js` (PGlite): CC parcial + contado entregada + facturada; por remito, factura, todas, una, saldo; saldo del cliente / liquidación coinciden; marcar pagada (resta) con descuento; revertir; los 5 puntos de "Revisar en especial".
- [ ] Tablas en `db.js`; modelo; `armar()` suma renglones; `liquidacion()` devuelve `descuentosSaldo`.
- [ ] Correr nuevas + `liquidaciones*.test.js` + `estado-pago*.test.js` + `saldos-unificados`; commit.

### Tarea 3: rutas, pantallas, JS y PDF

- [ ] `src/routes/descuentos.routes.js` montado en `/descuentos`: `GET /opciones`, `POST /vista-previa` (JSON), `POST /` (form), `POST /:id/revertir` (form), `GET /cliente/:id` (JSON).
- [ ] Partials `descuentos_botones.ejs`, `modal_descuento.ejs`, `modal_descuentos_aplicados.ejs`; `public/js/descuentos.js`; incluir en Liquidaciones (con cliente) y Cuenta corriente.
- [ ] PDF: línea de descuentos sobre el saldo.
- [ ] Pruebas de vista (render con / sin descuentos); prueba en Chrome headless con PGlite; commit.

### Tarea 4: diseño con ui-ux-pro-max

- [ ] Revisar modales y botones con la skill; ajustar SCSS; capturas; commit.
