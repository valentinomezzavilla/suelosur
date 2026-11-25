# Anular un pago de cliente desde Transacciones — diseño corto

Fecha: 2026-11-25. Tamaño: cambio chico. Aprobado por el usuario en la conversación.

## Intención

Un pago de cliente (por ejemplo, un pago por remito que cubría 4 obras) es **un solo movimiento** de la cuenta
corriente (`movimientos_cuenta`, tipo `pago`) con sus obras asignadas (`imputaciones_pago`). En Transacciones
aparece como **una sola fila `PAG-NNNNNN`**. Hoy esa fila solo tiene un enlace a la cuenta corriente; para anularlo
hay que ir a la cuenta del cliente. Se pide poder **anular el pago desde esa fila** y que las operaciones que cubría
**vuelvan a quedar pendientes**.

## Objetivos

- Ícono "Anular pago" en cada fila `PAG-…` de Transacciones (solo `admin_contable` y `dueno`).
- Modal con vista previa: qué operaciones vuelven a pendiente (con importe) y el saldo del cliente antes / después.
- Motivo obligatorio. Misma anulación que ya existe (`ClientesModel.anularPago`): queda en el historial de la cuenta
  con usuario, fecha y motivo, se audita y, si era transferencia a tercero, se borra su egreso.
- Tras anular, la fila sale de Transacciones y de las entradas del período (la unión ya excluye los anulados).

## No objetivos

- Cobros de contado (CAN / VIA / CON / MAQ): siguen con "Eliminar" y "Marcar pendiente".
- La cuenta corriente del cliente no cambia (su botón "Anular este pago" con `prompt()` queda como está).
- Anular pagos con cheque: no se hace acá (se deshabilita el cheque desde Cheques; el mensaje lo dice).
- Mostrar el pago anulado tachado en Transacciones (se eligió que desaparezca).

## Enfoques

1. **(elegido)** Reutilizar `ClientesModel.anularPago` y sumar en Transacciones un modal con vista previa.
   Sin lógica nueva de saldos: el estado de pago de cada operación se deduce de los pagos vigentes, así que
   al anular el pago las operaciones vuelven solas a pendiente.
2. Solo dejar el enlace a la cuenta corriente: ya está hoy y no cumple lo pedido.
3. "Marcar pendiente" (`estadoPago.model`): trabaja por operación / remito y reescribe pagos; no anula el pago entero.

## Diseño

- **Vista previa** (`ClientesModel.vistaPreviaAnularPago(movId)` → objeto): carga la imputación del cliente
  (`imputacionDe`), la recalcula con `imputar()` sin ese pago (y sin sus asignaciones) y compara `porOperacion()`
  antes / después. Devuelve las operaciones cuyo "pagado" baja (N° de OP, tipo, remito, obra, importe que vuelve a
  pendiente), el saldo antes / después y los bloqueos (cheque, ya anulado, no es un pago). Como se compara la cuenta
  entera, incluye cualquier otra operación que se mueva (los pagos sin obra elegida se aplican a lo más viejo).
- **Rutas** (`transacciones.routes.js`, `roles('admin_contable','dueno')`):
  - `GET /transacciones/pagos/:id/anular/vista-previa` → JSON.
  - `POST /transacciones/pagos/:id/anular` (motivo) → llama a la anulación y a la auditoría, `flash` y `redirect back`.
- **Auditoría:** se mueve a un solo lugar (`ClientesModel.anularPagoAuditado` o helper) para que la use el controlador
  de Clientes y el de Transacciones sin duplicar.
- **Vista:** en `views/pages/transacciones/index.ejs`, dentro de `.acciones-fila`, un `btn_icono` (`ban`, `btn-outline-danger`,
  clase `btn-anular-pago`) junto al enlace a la cuenta corriente, visible con `puedeCorregir`. Modal propio
  (mismo estilo `tx-modal`). `public/js/transacciones.js` pide la vista previa, la pinta y habilita "Sí, anular pago"
  solo con motivo y sin bloqueos.
- **Convenciones del proyecto:** acción de fila solo ícono con tooltip y `aria-label`; ids BIGINT comparados con `String()`.

## Qué queda al que construye

- Texto exacto de los avisos, estilos finos del modal y el orden de las operaciones en la lista.
- Verificación: pruebas con PGlite del modelo y de la ruta (un pago por remito sobre 4 obras → las 4 vuelven a
  pendiente y el saldo acompaña; cheque bloqueado; ya anulado; sin permiso) y revisión del modal en Chrome headless.
