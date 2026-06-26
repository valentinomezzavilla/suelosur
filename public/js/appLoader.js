/**
 * appLoader.js — Loader global con logo animado.
 *
 * Muestra el overlay automáticamente cuando hay una operación que toma tiempo:
 *   - Navegación entre páginas (click en links internos)
 *   - Envío de formularios (POST/GET que procesa el servidor)
 *
 * También expone window.AppLoader.{show, hide} para cargas manuales (fetch).
 *
 * Para excluir un link/form puntual: agregar el atributo  data-no-loader
 * Para personalizar el texto:                              data-loading-text="..."
 */
(function () {
  'use strict';

  var loader = document.getElementById('appLoader');
  if (!loader) return;

  var textEl = loader.querySelector('.app-loader__text');
  var defaultText = textEl ? textEl.textContent : 'Cargando…';
  var safetyTimer = null;

  function show(text) {
    if (textEl) textEl.textContent = text || defaultText;
    loader.classList.add('is-active');
    loader.setAttribute('aria-hidden', 'false');
    // Red de seguridad: si la navegación se cancela o es una descarga,
    // ocultar el loader tras un tiempo para no dejarlo colgado.
    clearTimeout(safetyTimer);
    safetyTimer = setTimeout(hide, 12000);
  }

  function hide() {
    loader.classList.remove('is-active');
    loader.setAttribute('aria-hidden', 'true');
    if (textEl) textEl.textContent = defaultText;
    clearTimeout(safetyTimer);
  }

  window.AppLoader = { show: show, hide: hide };

  // Rutas que disparan una DESCARGA (PDF/Excel/reporte): no cambian de página,
  // así que mostrar el loader lo dejaría colgado. Se excluyen automáticamente.
  var DESCARGA_RE = /(\/pdf\b|\/remito\b|\/reporte\b|\/export\b|\/descargar\b|formato=(excel|pdf))/i;

  // Ocultar al cargar la página y al volver con el botón "atrás" (bfcache)
  window.addEventListener('pageshow', hide);

  // ── Navegación por links ───────────────────────────────────────
  document.addEventListener('click', function (e) {
    // Respetar modificadores de teclado (abrir en nueva pestaña, etc.)
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    if (typeof e.button === 'number' && e.button !== 0) return;

    var a = e.target.closest && e.target.closest('a');
    if (!a) return;

    var href = a.getAttribute('href');
    if (!href) return;
    if (href.charAt(0) === '#') return;                       // ancla interna
    if (a.target && a.target !== '_self') return;             // nueva pestaña
    if (a.hasAttribute('download')) return;                   // descarga
    if (a.dataset.noLoader !== undefined) return;             // exclusión manual
    if (/^(mailto:|tel:|javascript:)/i.test(href)) return;    // protocolos especiales
    if (DESCARGA_RE.test(href)) return;                       // descarga (PDF/Excel/reporte)
    // Link externo (otro dominio)
    if (/^https?:\/\//i.test(href) && a.host !== window.location.host) return;

    show(a.dataset.loadingText);
  });

  // ── Envío de formularios ───────────────────────────────────────
  document.addEventListener('submit', function (e) {
    var form = e.target;
    if (!(form instanceof HTMLFormElement)) return;
    if (form.dataset.noLoader !== undefined) return;
    if (form.target && form.target !== '_self') return;       // abre en nueva pestaña
    var action = form.getAttribute('action') || '';
    if (DESCARGA_RE.test(action)) return;                     // genera descarga
    // Solo si el formulario pasó la validación nativa del navegador
    if (typeof form.checkValidity === 'function' && !form.checkValidity()) return;

    show(form.dataset.loadingText);
  });
})();
