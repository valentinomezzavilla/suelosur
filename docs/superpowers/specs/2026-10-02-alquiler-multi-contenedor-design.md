# Alquiler con varios contenedores — diseño

Fecha: 2026-10-02 · Estado: pendiente de revisión · Módulo: Alquileres de contenedores (`tipo_op = 'C'`)

## 1. Objetivo y alcance

Poder cargar **más de un contenedor en un mismo alquiler** (mismo cliente, misma dirección,
mismo remito) sin romper el workflow actual de reserva, despacho, entrega, vencimiento, retiro y
cobro.

Hoy el caso se resuelve a mano cargando dos alquileres idénticos (ej. Lanfranconi: OP-0251 y
OP-0252, Ambrosio Olmos 515, mismo día, $155.000 cada uno).

### Decisiones del usuario

- **Cada contenedor va por su cuenta:** se despacha, entrega, vence y retira por separado (viajes,
  días y camiones distintos).
- **Cobro elegible al crear el alquiler**, solo si tiene más de un contenedor: *por contenedor* o
  *por alquiler*.
- **Un N° de remito por alquiler.** Los remitos son físicos por ahora: lo que genera el sistema es
  informativo y **nada puede bloquear el workflow**.
- **Enfoque B:** el alquiler es un grupo de operaciones, una por contenedor (se descartó meter N
  contenedores dentro de una sola operación: cambio grande y de alto riesgo).
- **Listados:** una fila por contenedor con insignia de grupo.
- **Altas con varios contenedores en la v1:** normal y "ya en curso".
- **Cuenta corriente con cobro por alquiler:** un solo cargo por el total.

### Fuera de alcance (v1)

- Alquiler programado encadenado ("próximos a finalizar") y carga histórica ya finalizada con varios
  contenedores: siguen de a uno.
- Mezclar en un grupo contenedores "disponibles" con "próximos a finalizar".
- Remito/PDF firmado por contenedor.
- Cambios en la hoja de ruta del chofer (sigue siendo una tarea por contenedor).

## 2. Modelo de datos

- Tabla nueva **`alquiler_grupos`**: `id`, `cobro_modo` (`'contenedor'` | `'alquiler'`), `created_at`
  (con `ahora_local()`).
- Columna nueva **`op_encabezado.id_grupo`** (BIGINT, FK a `alquiler_grupos`, NULL por defecto).
- Un alquiler de un solo contenedor **no crea grupo**: `id_grupo` queda NULL y todo se comporta
  exactamente como hoy.
- **Compartido por el grupo** (se copia a cada OP al crear): cliente, dirección, obra, zona, N° de
  remito, método de pago, observaciones, fecha de inicio.
- **Propio de cada OP**: contenedor, plazo, precio, chofer, camión, estado, retiro, firma/foto.
- Migración en `initDB()` (`CREATE TABLE IF NOT EXISTS` + `ADD COLUMN IF NOT EXISTS`) y copia en
  `migrations/`. No modifica datos existentes.
- La "OP principal" del grupo es la de menor `id`; se usa para anclar el cargo de cuenta corriente.

## 3. Alta del alquiler

**Pantalla** (`views/pages/alquileres/nuevo.ejs`, `public/js/alquilerService.js`):

- El paso 1 pasa a selección múltiple en las tarjetas "Disponibles" (check + contador). Con un solo
  contenedor el flujo es idéntico al actual.
- Con 2 o más, el modal lista los contenedores elegidos con **plazo y precio por contenedor**
  (arrancan iguales al primero y son editables) y muestra el selector **"Cobrar por contenedor / por
  alquiler"**.
- El tipo "ya en curso" (inicio anterior a hoy) también admite varios contenedores. El resto de las
  reglas actuales (cuenta corriente, plazo según cliente, sin fecha de fin) se aplican a cada OP.

**Servidor** (`AlquileresModel.crearGrupo`, controlador `crear`):

- Crea el grupo y una OP por contenedor en **una sola transacción**. Para eso se extrae el cuerpo de
  `crear` y `crearEnCurso` de modo que reciban el cliente de transacción.
- Un único N° de remito para todo el grupo: el cargado a mano o, si está vacío, un solo número
  automático. El sistema ya admite repetir un remito entre operaciones.
- Cada OP toma su propio `nro_op`.
- Si un contenedor ya no está disponible, o se repite en la selección, **no se crea ninguna OP** y el
  mensaje nombra el contenedor.
- La geocodificación se hace una vez y las coordenadas se copian a todas las OP del grupo.
- Facturación: `marcarAlCrear` se aplica a cada OP con su propio monto.

## 4. Workflow y pantallas

- **Ciclo por contenedor:** sin cambios. Cada OP tiene su estado, chofer, camión, vencimiento y
  retiro. La hoja de ruta del chofer no se toca.
- **Listados y tarjetas "Por finalizar":** una fila por contenedor (los vencimientos son por
  contenedor). `listarPorEstado` devuelve además `id_grupo` y la cantidad de contenedores del grupo
  para mostrar la insignia **"Grupo · N contenedores"**.
- **Detalle de una OP** (`detalle.ejs`): panel "Alquiler agrupado" con los demás contenedores
  (OP, N°, estado, días restantes, link) y el resumen de cobro del grupo.
- **Mapa:** un pin por contenedor. Si varios comparten coordenadas, se separan unos metros solo al
  dibujar (no se modifica lo guardado).
- **Acciones grupales** (fase 3): "Anular alquiler completo" (anula las OP todavía anulables) y
  "Aplicar a todos los contenedores del alquiler" al editar los datos compartidos.

## 5. Cobro

**Por contenedor:** igual que hoy; cada OP se cobra al retirarse.

**Por alquiler:** `cobrarAlCerrar` pasa a reconocer el grupo.

1. Al retirar una OP cuyo grupo tiene `cobro_modo = 'alquiler'`, se buscan las OP hermanas no
   anuladas que sigan **abiertas** (sin entregar, o entregadas cuyo contenedor no volvió a
   `disponible`).
2. Si queda alguna abierta, **no se cobra**: se devuelve "diferido" y la pantalla informa cuántos
   faltan.
3. Si es la última, se calcula el cierre de cada OP (`datosCierre`, con la posibilidad de ajustar el
   precio por contenedor) y se cobra **una sola vez**, con un único método de pago:
   - una fila en `transacciones` **por OP**, con su monto, para no alterar la facturación, el
     borrado y el control de "ya cobrada" (todo eso es por operación);
   - si el método es cuenta corriente o saldo a favor, **un solo movimiento** en `movimientos_cuenta`
     por el total, anclado a la OP principal, con el detalle de contenedores en la descripción.
4. Es idempotente: las OP que ya tienen transacción se saltean, y el movimiento de cuenta solo se
   crea si en esa llamada se creó alguna transacción.
5. **"A convenir":** `pendientesDeCobro` muestra **una sola línea por grupo** cuando todas las OP
   están retiradas y ninguna tiene transacción; `resolverCobranza` cobra el grupo completo. El retiro
   desde la hoja de ruta (que no manda método) sigue dejando el cobro pendiente, como hoy.
6. Una OP anulada antes de entregarse deja de contar. Si las demás ya estaban retiradas, el cobro se
   dispara en ese momento.

**Casos a resolver en la implementación**

- `TransaccionesModel.eliminar` borra la operación completa. En la v1, para una OP de un grupo con
  cobro por alquiler y cargo de cuenta corriente, **se bloquea con un mensaje claro**.
- Cobro por alquiler con una sola OP restante (el resto anuladas) se comporta como cobro normal.

## 6. Fases de entrega

1. **Modelo y alta:** migración, `crearGrupo`, selección múltiple, insignia y panel del grupo.
2. **Cobro:** `cobrarAlCerrar` por grupo, Cobranzas, bloqueo de eliminación y mensajes de retiro.
3. **Acciones y mapa:** anular/editar para todo el grupo, separación de pines, y un script para
   agrupar pares ya cargados (OP-0251 y OP-0252).

Cada fase se entrega en su rama, con pruebas aisladas contra la base y rollback, y se mergea a main
recién cuando está verificada.

## 7. Pruebas

Por fase, con transacción y rollback (como las pruebas del mapa y de la hora):

- Alquiler de un contenedor: resultado idéntico al actual (alta, entrega, retiro, cobro).
- Alta de 2 y 3 contenedores: grupo, OP, remito compartido, plazo y precio por contenedor.
- Alta atómica: un contenedor ocupado o repetido deshace todo.
- Ciclo independiente: entregar y retirar en distinto orden y día.
- Cobro por contenedor: un cobro por OP, en su momento.
- Cobro por alquiler: sin cobro hasta el último retiro; luego una transacción por OP y un solo cargo
  de cuenta corriente por el total; segunda ejecución sin duplicados.
- "A convenir": una sola línea en Cobranzas y resolución del grupo completo.
- Anulación de un contenedor pendiente con cobro por alquiler.
- Regresión: listados, hoja de ruta, circuitos, zonas, remito PDF, facturación y mapa.

## 8. Riesgos

- `cobrarAlCerrar` tiene cuatro llamadas (dos en `alquileres.controller`: retiro desde el detalle y
  Cobranzas; dos en `hojaRuta.controller`: retiro del chofer): el cambio de grupo debe ser
  transparente para las cuatro.
- Los totales de reportes y dashboards siguen siendo por detalle/OP y no deberían cambiar; se verifica
  en la fase 2.
- El panel y la insignia dependen de `id_grupo`: toda consulta nueva debe tolerar NULL.
