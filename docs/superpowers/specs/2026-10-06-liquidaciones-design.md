# Liquidaciones — diseño

Fecha: 2026-10-06 · Rama: `feat/liquidaciones`

## Objetivo

Un solo lugar para ver **todas las operaciones de un cliente** (ventas en cantera, ventas con
viaje, alquileres de contenedor y de maquinaria) con su detalle, su estado de pago y los totales,
y generar un **PDF para compartirle al cliente**: muy detallado y bien presentado.

Hoy esa información está repartida entre Historial de ventas (solo ventas), Transacciones (solo
lo cobrado), Cuentas corrientes (solo clientes con CC) y la ficha del cliente (cuyo "Historial de
alquileres" está vacío).

## Decisiones tomadas

| Tema | Decisión |
|---|---|
| Contenido | Operaciones con detalle **+ estado de pago** de cada una + totales consumido / pagado / saldo (opción B) |
| Cliente | Opcional. **Con cliente**: liquidación del cliente. **Sin cliente**: todos los clientes, agrupados |
| Pagos | Sección "Pagos recibidos del período", solo con cliente elegido y **sin** obra |
| Filtros | Cliente, Obra, Desde/Hasta (default mes actual), Tipo de operación (multi), Estado de pago |
| Anuladas | No entran nunca |
| Alquiler sin precio | Entra con la leyenda "Precio a convenir"; no suma a los totales |
| PDF sin cliente | Sí: "Liquidación general" (resumen por cliente + detalle, cada cliente en página nueva) |
| N° de liquidación | Informativo, no se guarda: `LIQ-AAAAMMDD-<id cliente con 4 dígitos>` (sin cliente: `LIQ-AAAAMMDD-GRAL`) |
| Base de datos | Sin migraciones |

## Menú

- **Contabilidad → Cobranzas** se reemplaza por **Contabilidad → Liquidaciones** (`/liquidaciones`).
- `GET /cobranzas` sigue existiendo y redirige a `/clientes/cuentas` (favoritos viejos).
- El destino al loguearse del rol `admin_contable` pasa de `/cobranzas` a `/liquidaciones`
  (`src/app.js` y `src/routes/auth.routes.js`).
- **Contenedores → Cobranzas** (Asignar precio) **no se toca**.
- Clientes → Cuentas corrientes sigue igual.

## Pantalla `/liquidaciones`

Acceso: roles `dueno` y `admin_contable` (los mismos que hoy `/cobranzas`).

**Filtros** (GET, todo en la URL para que el PDF use exactamente los mismos):

| Parámetro | Valor | Default |
|---|---|---|
| `clienteId` | id de cliente (buscador de cliente existente, `buscarCliente.js`) | vacío = todos |
| `obra` | clave de obra (`ClientesModel.obras` / `obraPorClave`) | vacío; deshabilitado sin cliente |
| `desde`, `hasta` | `YYYY-MM-DD`, sobre la fecha de la operación (misma expresión `FECHA` del Libro de ventas) | primer y último día del mes actual |
| `tipos` | uno o varios de `cantera`, `viaje`, `contenedor`, `maquinaria` | todos |
| `estadoPago` | `todas`, `pendientes` (pendiente + parcial), `pagadas` | `todas` |

Botones: **Ver**, **Limpiar**, **Descargar PDF** (abre `/liquidaciones/pdf?<mismos filtros>`).

**Con cliente:**
1. Tarjetas: Total consumido · Total pagado · Saldo pendiente · Cantidad de operaciones.
2. Una tarjeta por operación (de la más vieja a la más nueva):
   - Encabezado: N° OP, remito, fecha, tipo, obra o dirección, badge de estado (PAGADA verde,
     PARCIAL naranja, PENDIENTE rojo, A CONVENIR gris) y botón "Ver" a la operación.
   - Detalle según tipo (ver "Detalle por tipo").
   - Pie: total de la operación, pagado, resta.
3. Pagos recibidos del período (solo sin obra): fecha, método, descripción, monto, total.

**Sin cliente:**
1. Las mismas tarjetas de totales, de todos los clientes.
2. Tabla resumen por cliente: cliente, operaciones, consumido, pagado, saldo, link "Ver
   liquidación" (= misma URL con ese `clienteId`).
3. Debajo, por cliente, un título con su nombre y sus tarjetas de operaciones.
4. Sin sección de pagos.

Sin operaciones: mensaje "Sin operaciones en el período" (con cliente o sin cliente).

## Detalle por tipo

| Tipo | `tipo_op` / filtro | Renglones |
|---|---|---|
| Venta en cantera | `M`, modalidad ≠ `flete` | producto, cantidad, unidad, precio unitario, importe; + **Flete** y **Ajuste de precio** si existen (`importesVenta`) |
| Venta con viaje | `M`, modalidad = `flete` | ídem |
| Alquiler de contenedor | `C` | contenedor N°, dirección, desde / hasta, días, precio por día, importe |
| Alquiler de maquinaria | `MA` | máquina, horas, precio por hora, importe |

El total de una venta es el total pactado (`SQL_TOTAL` / `importesVenta`), igual que en el resto
del sistema. Los datos de contenedor (N°, fechas, días, precio por día) salen de lo que ya usan
el detalle de alquiler y Cobranzas; en el plan se fija la consulta exacta.

## Estado de pago de cada operación

Lógica pura en `src/utils/liquidaciones.js`, a partir de `{ total, metodoPago, cobrada, cc }`:

| Caso | Pagado | Estado |
|---|---|---|
| Alquiler sin precio asignado | 0 | **A CONVENIR** (no suma a ningún total) |
| Método `cuenta_corriente` | `pagado` de `ClientesModel.saldadaPorOperacion` (imputación FIFO del estado de cuenta) | PAGADA si resta ≤ 0,01 · PARCIAL si pagado > 0 · si no PENDIENTE |
| Método `saldo_a_favor` | total (se paga en el momento con crédito; movimiento `uso_saldo_favor`) | PAGADA |
| Contado (efectivo, transferencia, cheque) | total si tiene transacción con `metodo_pago <> 'cuenta_corriente'`; si no 0 | PAGADA o PENDIENTE |
| CC sin cargo todavía (alquiler en curso) | 0 | PENDIENTE |
| Método `a_convenir` o sin método (se define al finalizar) | igual que contado: total si ya tiene transacción de cobro, si no 0 | PAGADA o PENDIENTE |

`resta = max(0, total − pagado)`.

El filtro `estadoPago` se aplica después de calcular el estado. A CONVENIR entra solo con `todas`.

## Pagos recibidos (con cliente, sin obra)

Dentro del período, del cliente:
- `movimientos_cuenta` con `tipo = 'pago'` (abonos de CC, cheques acreditados): fecha
  (`created_at`), método (`metodo_pago`), descripción, monto.
- `transacciones` con `metodo_pago <> 'cuenta_corriente'` y `tipo <> 'Ajuste'`: cobros de contado
  (fecha, método, descripción, monto).

Verificado en el código: los abonos de CC **no** generan transacción y las ventas a CC generan
transacción con método `cuenta_corriente`, así que no hay doble conteo.

## Totales y resumen por obra

- **Total consumido** = Σ total de las operaciones listadas (sin A CONVENIR).
- **Total pagado** = Σ pagado. **Saldo pendiente** = Σ resta.
- **Resumen por obra** (PDF con cliente, sin obra filtrada y con más de una obra): agrupado con
  `agruparObras` / `nombreObra` (`src/utils/obras.js`), con consumido / pagado / saldo.
- **Resumen por cliente** (sin cliente): ídem agrupado por cliente.

## PDF `/liquidaciones/pdf`

`src/utils/pdfLiquidacion.js`, pdfkit A4 vertical, con `pdfBrand` (`drawHeader`, `drawFooter`,
colores).

1. Encabezado: logo y empresa; a la derecha **LIQUIDACIÓN**, N°, período, fecha de emisión, obra
   (si hay).
2. Ficha del cliente: nombre, N° de cliente, DNI, teléfono, dirección, email (los que tenga).
3. Resumen destacado: Total consumido · Pagado · **Saldo pendiente** (rojo si > 0, verde si 0).
4. Operaciones: barra de título (`OP-0308 · Remito 1234 · 06/10/2026 · Venta con viaje · Obra …`
   + etiqueta de estado), tabla de detalle, pie con total / pagado / resta. Una operación no se
   corta entre páginas salvo que no entre en una página entera.
5. Resumen por obra (condiciones de arriba).
6. Pagos recibidos del período (condiciones de arriba).
7. Pie en todas las páginas: "Página X de Y", fecha de emisión y la leyenda *"Los pagos se
   imputan a las operaciones más antiguas. Ante cualquier diferencia, comuníquese con
   administración."*

Sin cliente ("Liquidación general"): encabezado con "LIQUIDACIÓN GENERAL", resumen general,
tabla resumen por cliente y luego cada cliente en página nueva con su ficha, resumen y
operaciones (sin pagos).

Nombre del archivo: `liquidacion-<cliente-o-general>-<desde>-<hasta>.pdf`.

## Componentes

| Archivo | Responsabilidad |
|---|---|
| `src/utils/liquidaciones.js` | Lógica pura: estado de pago, totales, filtro por estado, agrupado por cliente / obra, N° de liquidación, rango default del mes |
| `src/models/liquidaciones.model.js` | `liquidacion(filtros)` → `{ clientes: [{ cliente, operaciones, pagos, resumen, porObra }], resumen }` (una sola entrada en `clientes` cuando hay `clienteId`) |
| `src/controllers/liquidaciones.controller.js` | Leer y normalizar filtros, render de la pantalla, PDF |
| `src/routes/liquidaciones.routes.js` | `GET /` y `GET /pdf`, con `auth` + `roles('admin_contable','dueno')` |
| `views/pages/liquidaciones/index.ejs` | Pantalla |
| `src/utils/pdfLiquidacion.js` | PDF |
| `src/scss/pages/_liquidaciones.scss` | Estilos de la pantalla |
| `views/partials/sidebar.ejs`, `src/app.js`, `src/routes/auth.routes.js` | Menú y destino del rol contable |

## Errores

- `clienteId` inexistente → aviso "Cliente no encontrado" y la pantalla sin cliente.
- Filtros inválidos (fechas mal formadas, tipos desconocidos) se ignoran y se usan los defaults.
- Error de base → flash "Error al generar la liquidación." y redirect a `/liquidaciones` (pantalla)
  o la misma redirección desde el PDF.

## Pruebas

- **Unitarias** (`tests/liquidaciones.test.js`): estado de pago de cada caso de la tabla, totales
  (A CONVENIR no suma), filtro por estado, agrupado por cliente y por obra, N° de liquidación.
- **Contra la base con ROLLBACK** (`tests/liquidaciones-modelo.test.js`, arnés `tests/helpers/db`):
  cliente de prueba con una venta de contado cobrada, una venta a CC con pago parcial y un alquiler
  sin precio → estados, pagado, resta y totales; filtro por tipo y por estado; sin cliente incluye
  al cliente de prueba en el agrupado.
- **PDF**: generarlo con y sin cliente sobre un `res` simulado no tira errores y produce bytes.
- **Vista**: render de `liquidaciones/index` con y sin cliente (helper `tests/helpers/vistas`).

## Fuera de alcance

- Guardar o numerar correlativamente las liquidaciones emitidas.
- Envío por WhatsApp o mail.
- Excel.
- Arreglar "Historial de alquileres" vacío de la ficha del cliente (se puede reemplazar por un link
  a Liquidaciones en un cambio aparte).
