# Alquiler de contenedor sin precio — diseño

Fecha: 2026-10-02 · Estado: implementado en rama, pendiente de revisión · Módulo: Alquileres de contenedores (`tipo_op = 'C'`)

## 1. Objetivo

Que los alquileres de contenedor **nuevos** se carguen sin precio y sin método de pago, y queden en
**Contenedores → Cobranzas → "Asignar precio"** hasta que alguien les asigne los dos. Los alquileres
ya cargados (con precio, o "a convenir") siguen exactamente como hoy.

### Decisiones confirmadas

- **Monto:** el precio asignado es el que se cobra. Se sugiere según el **plazo cargado en el alta**
  a la tarifa por días vigente (hasta 8 días, por día; desde 9, el precio base). Si después se amplía
  el plazo, el sugerido suma esos días; los días de más sin ampliar no se cobran. Un alquiler sin fecha
  de fin no tiene plazo: se sugiere por los días reales.
- **Cuándo se cobra:** si el contenedor **ya se retiró**, al asignar el precio (no hay otro momento);
  si **sigue en curso o pendiente**, al retirarlo (oficina o chofer), con el precio asignado.
- **Agrupados:** "por contenedor / por alquiler" ya no se elige en el alta: se elige **al asignar el
  precio** (arranca "por contenedor").
- **Carga histórica:** "ya finalizó" sigue pidiendo precio y método (registra el ingreso con la fecha
  pasada); "sigue en curso" va sin precio, como los demás.
- **"A convenir":** dos secciones en Cobranzas. Los "a convenir" ya cargados no se tocan.
- **Editar:** el precio y el método de un alquiler sin precio no se editan; se asignan solo en Cobranzas.

## 2. Modelo de datos

- `op_detalle_contenedor.precio_alquiler` **NULL = sin precio** (distinto de $0, un precio cero a
  propósito). La columna ya admitía NULL: no se cambia. `op_encabezado.metodo_pago` queda NULL.
- Columna nueva `op_detalle_contenedor.precio_asignado_en` (TEXT, hora local, `ADD COLUMN IF NOT EXISTS`
  en `initDB()` y copia en `migrations/2026-10-02_asignar_precio.sql`). Distingue un precio **asignado**
  (se cobra tal cual) de uno **cargado en el alta** (los viejos: al retirar se cobra la tarifa por días,
  y el precio de alta queda de referencia). NULL en todo lo existente.
- El arnés de pruebas aplica la migración dentro de la transacción de prueba si todavía no está
  desplegada (se deshace con el ROLLBACK).

## 3. Alta

`AlquileresController.crear`: ningún alquiler nuevo guarda precio ni método (un formulario viejo que los
mande se ignora), salvo la carga histórica "ya finalizó", que los exige (el método tiene que ser uno
real: `efectivo`, `transferencia`, `cheque`, `cuenta_corriente` o `saldo_a_favor`).

- Aplica a: normal, programado/encadenado, "ya en curso", histórico "sigue en curso" y varios contenedores.
- "Operación para facturar" se conserva (sección propia). Sin precio guarda `monto_facturar = NULL` (no 0),
  para que el monto salga del precio asignado después.
- El plazo por defecto sigue dependiendo de la cuenta corriente del **cliente**, no del método de pago.
- Formulario (`nuevo.ejs`, `alquilerService.js`): el bloque de precio y método está oculto y
  deshabilitado salvo en "histórico ya finalizó"; las filas de varios contenedores ya no piden precio ni
  el modo de cobro.

## 4. Cobranzas → Asignar precio

`AlquileresModel.sinPrecio()` lista los alquileres sin precio, sin anular: cliente, OP, contenedor,
dirección, inicio, **estado** (pendiente / en curso / retirado), días transcurridos, plazo y **precio
sugerido** (editable). Los retirados van primero. Debajo queda la sección "A convenir", igual que antes.

- **Un contenedor:** `asignarPrecio(id_op, { precio, metodo_pago })`. Transacción con la OP bloqueada.
  Si ya se retiró, genera la transacción y, si corresponde, el cargo en cuenta corriente / saldo a favor
  (sin la referencia "Precio inicial", que acá no aplica).
- **Alquiler agrupado sin precio en ningún contenedor:** además se ofrece "todo junto"
  (`asignarPrecioGrupo`): un precio por contenedor y un solo método; el grupo pasa a cobro "por alquiler"
  (una transacción por OP y **un solo cargo en cuenta corriente por el total**). Si ya se retiraron todos,
  cobra ahora; si falta alguno, cobra todo junto al retirar el último. Cada contenedor también se puede
  asignar por separado ("por contenedor").
- **Métodos:** efectivo, transferencia, cheque, cuenta corriente y saldo a favor. Cuenta corriente solo
  se ofrece si el cliente la tiene habilitada y saldo a favor solo si tiene saldo; **el servidor lo valida
  igual** (mensaje claro, sin cambios). "A convenir" ya no es una opción.
- Precio vacío o negativo se rechaza; **$0 es válido** (sin cargo) y la pantalla pide confirmación.
- Asignar dos veces, o un alquiler anulado, se rechaza. Queda registro en `auditoria`
  (`asignar_precio` / `asignar_precio_grupo`, con usuario y detalle).

## 5. Retiro sin precio

`cobrarAlCerrar` y `cobrarGrupo` devuelven `null` sin tocar nada si falta el precio: **el retiro nunca se
bloquea** (oficina ni chofer, incluido el que lleva el contenedor al próximo alquiler encadenado) y **no se
genera un cobro de $0**. El alquiler sigue en "Asignar precio" como "retirado". La oficina ve un aviso con
el link; el cierre de la pantalla de detalle no pide monto ni método.

`cobrarAlCerrar` (un contenedor) pasó a correr en una transacción con la OP bloqueada, la misma fila que
bloquea `asignarPrecio`: un retiro y una asignación simultáneos no pueden dejar un alquiler retirado, con
precio y sin cobrar (y dos cierres a la vez no cobran dos veces).

## 6. Partes revisadas

| Parte | Resultado |
|---|---|
| Plazo | Sin cambios; probado sin método de pago (10 días con cuenta corriente, 4 sin ella). |
| Listado y detalle | "Sin precio" (insignia en listado y tarjetas, contador en el botón Cobranzas, detalle, historial del contenedor, panel del grupo). |
| Remito / hoja de ruta | Remito (PDF) dice "A definir". La hoja de ruta no muestra precios. |
| Cuenta corriente | "Operaciones sin cargo" estima con el precio asignado; un alquiler sin precio no aparece. |
| Totales | Libro de ventas (importe 0 hasta asignar), facturación (`monto_facturar` NULL), dashboard (solo transacciones): sin cambios en lo existente. |
| Ampliar plazo | El sugerido suma los días. Si el precio ya estaba asignado y sin cobrar, se avisa que no se recalcula (se ajusta en Editar). |
| Encadenados / "ya en curso" | Nacen sin precio; el retiro del anterior no cobra. |
| Edición | Un alquiler sin precio no muestra ni toca precio y método (no le pone $0); "aplicar a todos" no copia método a contenedores sin precio. |

## 7. Pruebas

Con transacción y ROLLBACK, como las anteriores (`npm test`):

- `alquiler-sin-precio.test.js` (modelo): alta, retiro sin cobro, listado, asignación individual y por
  grupo, edición, regresión de los alquileres ya cargados, totales y comprobantes.
- `alquiler-sin-precio-controlador.test.js`: alta (todas las variantes), retiro de la oficina y del chofer
  desde la hoja de ruta, Cobranzas, asignación, ampliar, detalle y edición con las vistas reales.
- `alquiler-sin-precio-vistas.test.js`, `alquiler-sin-precio-migracion.test.js`.
- Ajustadas las pruebas anteriores que describían el alta con precio y el selector de cobro.

## 8. Riesgos y notas

- `precio_alquiler` es `REAL`: importes con centavos de más de 7 cifras pierden precisión (ya era así).
- Un precio asignado no se recalcula si cambia la tarifa o el plazo: es el acordado.
- La carga histórica en lote ("ya finalizó") sigue necesitando precio y método porque registra el ingreso
  con la fecha original; pasarla a "Asignar precio" lo registraría con la fecha en que se asigna.
