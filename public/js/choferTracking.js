/**
 * choferTracking.js — Rastreo de ubicación en segundo plano para choferes.
 *
 * Se carga en todas las páginas mientras el chofer está logueado. Mantiene
 * un watchPosition activo y envía la posición al servidor a intervalos
 * regulares (throttle), independientemente de en qué página esté el chofer.
 *
 * Limitación inherente del navegador: solo rastrea mientras hay al menos una
 * pestaña del sistema abierta. Si el chofer cierra el navegador, se detiene.
 */
(function () {
  'use strict';

  // Intervalo mínimo entre envíos al servidor (ms). 30s es un balance razonable
  // entre precisión de seguimiento y consumo de datos/batería.
  const INTERVALO_ENVIO = 30000;

  // Si falla el permiso, no reintentar en bucle.
  let permisoDenegado = false;
  let ultimoEnvio = 0;
  let watchId = null;

  function enviarPosicion(coords) {
    const ahora = Date.now();
    if (ahora - ultimoEnvio < INTERVALO_ENVIO) return; // throttle
    ultimoEnvio = ahora;

    fetch('/hoja-de-ruta/posicion', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // keepalive permite que el envío sobreviva a una navegación de página
      keepalive: true,
      body: JSON.stringify({
        lat: coords.latitude,
        lng: coords.longitude,
        accuracy: coords.accuracy,
        velocidad: coords.speed ? coords.speed * 3.6 : 0, // m/s → km/h
      }),
    }).catch(function () { /* silencioso: reintenta en el próximo tick */ });
  }

  function onSuccess(pos) {
    enviarPosicion(pos.coords);
  }

  function onError(err) {
    if (err && err.code === 1) { // PERMISSION_DENIED
      permisoDenegado = true;
      if (watchId !== null) {
        navigator.geolocation.clearWatch(watchId);
        watchId = null;
      }
    }
    // Otros errores (timeout, posición no disponible): el watch sigue intentando.
  }

  function iniciar() {
    if (!navigator.geolocation || permisoDenegado || watchId !== null) return;

    watchId = navigator.geolocation.watchPosition(onSuccess, onError, {
      enableHighAccuracy: true,
      timeout: 20000,
      maximumAge: 15000,
    });
  }

  // Reanudar cuando la pestaña vuelve a estar visible (algunos navegadores
  // suspenden el watch en background).
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') iniciar();
  });

  // Arrancar al cargar
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', iniciar);
  } else {
    iniciar();
  }
})();
