# 🗺️ Sistema de GPS y Mapas - Guía de Prueba

## Requisitos Previos
- ✅ Servidor corriendo en `http://localhost:3000`
- ✅ Usuario chofer logueado
- ✅ Empleado vinculado al usuario chofer
- ✅ Operación (viaje) pendiente asignada al chofer

## Pasos para Probar

### 1. Acceder como Chofer
```
Usuario: chofer1
Contraseña: suelosur123
```

### 2. Ver Hoja de Ruta
- Ir a `/hoja-de-ruta`
- Deberías ver una lista de tareas del día
- Si no hay, crea una operación de viaje en `/ventas` y asígala al chofer

### 3. Iniciar Viaje
- Haz clic en botón **"Iniciar viaje"** en una tarea pendiente
- **Se abrirá automáticamente** la vista de viaje en curso con el mapa
- El navegador pedirá permiso para acceder al GPS

### 4. Permitir Acceso a GPS
- Haz clic en **"Permitir"** cuando se solicite acceso a ubicación
- Si estás en Windows/Escritorio:
  - Puedes simular ubicación en las DevTools (F12 → More tools → Sensors)
  - O instalar una extensión de GPS simulado

### 5. Ver el Mapa en Acción
- El mapa mostrará:
  - 📍 Tu ubicación actual (pin azul que se actualiza)
  - 🎯 Destino de entrega (pin rojo)
  - 🛣️ Ruta planificada (línea azul punteada)
  - 📏 Distancia en km
  - ⏱️ Duración estimada

### 6. Finalizar Viaje
- Haz clic en **"Finalizar viaje"** en la barra de controles
- Se abrirá un modal para cargar el remito firmado
- Sube una foto o PDF
- Haz clic en **"Confirmar entrega"**

### 7. Ver Ubicación del Chofer (Admin)
- Accede como admin: `usuario: admin_ventas`, `contraseña: suelosur123`
- Ve a `/choferes`
- Verás el botón **"📍"** (mapa) en la columna de acciones
- Haz clic para ver la última ubicación registrada del chofer

## Funcionalidades Clave

### Vista de Viaje en Curso
- ✅ Mapa Leaflet + OpenStreetMap
- ✅ GPS en tiempo real (actualización cada 5 segundos)
- ✅ Ruta automática calculada con OSRM
- ✅ Geocodificación de direcciones sin coordenadas
- ✅ Indicadores de distancia y duración
- ✅ Botones "Ver ruta" desde hoja de ruta para revisar mapa
- ✅ Rastreo persistente en BD

### Base de Datos
- Tabla `rastreo_chofer` almacena:
  - `id_op` - Operación siendo realizada
  - `id_empleado` - Chofer
  - `lat`, `lng` - Coordenadas
  - `velocidad` - Opcional
  - `exactitud` - Margen de error del GPS
  - `fecha_registro` - Timestamp

### API Endpoints
- `POST /hoja-de-ruta/:id/ubicacion` - Guardar ubicación
- `POST /hoja-de-ruta/:id/geocodificar` - Geocodificar destino
- `GET /hoja-de-ruta/ubicacion/actual` - Mi ubicación actual
- `GET /choferes/:id/ubicacion-actual` - Ubicación de un chofer

## Notas Importantes

### 📱 En Dispositivos Móviles
- El GPS funcionará mejor con navegadores modernos (Chrome, Firefox)
- Asegúrate de tener activado el GPS del dispositivo
- Accede vía `http://tu-ip:3000` (no localhost)

### 🖥️ En Escritorio
- Abre DevTools (F12)
- Ve a `More tools` → `Sensors`
- Simula una ubicación
- O usa extensión como "GPS Spoofing" de Chrome

### 🌐 Mapas Públicos
- OpenStreetMap es 100% gratuito y de código abierto
- OSRM (Open Source Routing Machine) también es gratuito
- Nominatim (geocodificación) es de OpenStreetMap
- **Sin límites de API, sin costos**

### 🔐 Seguridad
- El rastreo solo guarda datos de choferes logueados
- Cada chofer ve solo su propia ubicación
- Los admins ven ubicaciones de todos los choferes

## Mejoras Futuras
1. Historial completo de recorridos
2. Reportes de tiempo de viaje (real vs estimado)
3. Alertas de desvío de ruta
4. Estadísticas de velocidad
5. Mapa con todos los choferes activos (para dispatch)
6. Integración con cámaras de marcha atrás

¿Necesitas ayuda con las pruebas?
