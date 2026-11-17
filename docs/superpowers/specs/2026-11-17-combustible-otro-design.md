# Pago de combustible: opción "Otro" en camión y chofer — diseño

Fecha: 2026-11-17 · Estado: pendiente de aprobación · Módulo: Compras / Pagos (categoría con campo `carga`, hoy Combustible)

## 1. Objetivo

Que al registrar un pago de combustible se pueda elegir **"Otro"** en los desplegables **Vehículo** y
**Chofer**, para las cargas que son **a terceros, ajenos a la empresa**. Con "Otro" el pago se registra
con su monto, pero **no se asigna a ningún camión de la flota ni a ningún chofer**.

## 2. Decisiones confirmadas

- Una carga a tercero **no tiene camión ni chofer de la flota**: es una sola cosa, no dos. Elegir "Otro"
  en cualquiera de los dos desplegables deja **los dos** en "Otro" (y cambiar uno a un valor real
  limpia al otro, que vuelve a "Seleccionar…").
- Se muestra **el egreso**: aparece en Compras / Pagos como cualquier pago, con "Otro" donde iría el
  camión y el chofer. Nada más.

## 3. Mis decisiones (a confirmar al leer)

- **No se inventa deuda con la estación.** La cuenta de la estación suma deuda solo con las cargas de
  `combustible` (que exigen camión) y con cargos manuales. Una carga a tercero no entra ahí, así que el
  pago a la estación baja la deuda como cualquier otro pago (puede dejar saldo a favor si no había
  deuda). Si más adelante se quiere que la carga a tercero también figure como deuda en la cuenta de
  la estación, es un agregado aparte.
- **"Impacta en autonomía del camión" se desactiva** (y se destilda) con "Otro": no hay camión al que
  sumarle la carga. Flota y su consumo no se tocan.
- **El chofer obligatorio se cumple con "Otro"**: el pago se guarda sin `id_chofer` ni `id_vehiculo`.
- **Persistencia:** columna nueva `egresos.carga_tercero` (entero, 0/1, `ADD COLUMN IF NOT EXISTS` en
  `initDB()`, como las demás columnas de combustible de `egresos`). Es aditiva y no modifica nada existente. Hace falta porque, sin
  ella, un pago "Otro" no se distingue de uno viejo sin chofer, y al editarlo no se podría volver a mostrar
  "Otro".
- **Edición:** el formulario de edición abre con "Otro" elegido si `carga_tercero = 1`. Un pago que ya
  tenía carga en Flota (`id_combustible`) se puede pasar a "Otro" solo si se quita esa carga
  (hoy "Impacta" destildado ya la quita); se avisa en pantalla.
- **Listado y detalle** (`compras/index.ejs`): donde hoy sale el vehículo y el chofer, sale "Otro" para
  estos pagos. El filtro por vehículo no los incluye (no tienen vehículo).

## 4. Enfoques considerados

| Enfoque | Resultado |
|---|---|
| **Columna `carga_tercero` + valor "otro" en los selects (elegido)** | Simple, se ve y se edita sin ambigüedad, sin tocar Flota ni la cuenta de la estación. |
| Marcar "Otro" solo con `id` nulo (sin columna) | Sin migración, pero un pago viejo sin chofer se vería como "Otro" y la edición no puede distinguirlos. Descartado. |
| Guardar la marca en `datos_extra` (JSON) | Sin migración, pero no se puede consultar bien desde SQL si más adelante hace falta. Descartado. |
| Registrar la carga a tercero en `combustible` | Exige permitir `id_vehiculo` nulo y ensucia el consumo y las pantallas de Flota. Descartado. |

## 5. Alcance

- `views/pages/compras/form.ejs`: opción "Otro" en `selVehiculo` y `selChofer`; vinculación entre ambos;
  desactivar "Impacta" con "Otro".
- `src/controllers/compras.controller.js`: `crear` y `actualizar` aceptan "Otro" (valor `otro`), guardan
  ids nulos y `carga_tercero = 1`; no permiten "Otro" junto con "Impacta" (validación de servidor).
- `src/models/egresos.model.js`: lee y guarda `carga_tercero`.
- `src/config/db.js` (y el arnés de pruebas `tests/helpers/db.js`): la columna.
- `views/pages/compras/index.ejs`: muestra "Otro".
- Pruebas (`tests/`, con transacción y ROLLBACK, como las de combustible existentes): alta y edición con
  "Otro", sin camión ni chofer guardados, sin carga en Flota, validación de "Impacta" + "Otro", y que un
  pago con camión y chofer reales siga igual.

## 6. No objetivos

- No cambia la cuenta de la estación ni el cálculo de su deuda.
- No agrega nombre ni dato del tercero (ni patente, ni nombre del chofer).
- No cambia las otras categorías con campo `vehiculo` (solo `selVehiculo` dentro de la carga de combustible
  y el chofer).
- No migra pagos viejos.

## 7. Riesgos y notas

- En desarrollo, nodemon corre `initDB()` contra la base de producción en cada guardado: la columna es
  `ADD COLUMN IF NOT EXISTS` y no destructiva, pero conviene frenar nodemon antes de tocar la migración.
- El campo `vehiculo` es compartido por otras categorías: el "Otro" aplica solo cuando la categoría
  tiene el campo `carga` (donde está el chofer).
