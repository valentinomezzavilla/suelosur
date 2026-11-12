// ═══════════════════════════════════════════════════════════════════
// Tooltips de los botones de solo ícono (views/partials/btn_icono.ejs): [data-bs-toggle="tooltip"].
// Sin este script (o sin Bootstrap) el botón sigue teniendo su `title` nativo y su aria-label.
// El tooltip se muestra con el mouse y con el teclado (foco) y se esconde al hacer clic, para que
// no quede flotando encima del modal que abre el botón.
// ═══════════════════════════════════════════════════════════════════
(function () {
    if (!window.bootstrap || !window.bootstrap.Tooltip) return;
    document.querySelectorAll('[data-bs-toggle="tooltip"]').forEach(function (el) {
        const tip = window.bootstrap.Tooltip.getOrCreateInstance(el, {
            container: 'body',
            trigger: 'hover focus',
            placement: 'top',
            delay: { show: 250, hide: 0 },
        });
        el.addEventListener('click', function () { tip.hide(); });
    });
})();
