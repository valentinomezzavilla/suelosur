// ═══════════════════════════════════════════════════════════════════
// Modal "¿Agregar observación?" (views/partials/modal_observacion_pdf.ejs) antes de generar el
// PDF de una liquidación o de una cuenta corriente. Lo abre cualquier link a[data-pdf-observacion]:
//   "No"  → abre el PDF (el href del link) en una pestaña nueva, sin observación.
//   "Sí"  → muestra la caja de texto; "Generar PDF" lo abre con la observación (parámetro obs).
// ═══════════════════════════════════════════════════════════════════
(function () {
    const modal = document.getElementById('modal-observacion-pdf');
    if (!modal) return;
    const $ = (id) => document.getElementById(id);
    const opciones = $('obsPdfOpciones');
    const form = $('obsPdfForm');
    const texto = $('obsPdfTexto');
    let href = null;

    function cerrar() { modal.style.display = 'none'; href = null; }

    function abrir(link) {
        href = link.getAttribute('href');
        opciones.style.display = '';
        form.style.display = 'none';
        texto.value = '';
        modal.style.display = 'flex';
        $('obsPdfSi').focus();
    }

    function generar(obs) {
        if (!href) return;
        const url = new URL(href, location.origin);
        url.searchParams.delete('obs');
        if (obs) url.searchParams.set('obs', obs);
        window.open(url.pathname + url.search, '_blank');
        cerrar();
    }

    document.addEventListener('click', (e) => {
        const link = e.target.closest('a[data-pdf-observacion]');
        if (!link || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        abrir(link);
    });
    $('obsPdfNo').addEventListener('click', () => generar(''));
    $('obsPdfSi').addEventListener('click', () => {
        opciones.style.display = 'none';
        form.style.display = '';
        texto.focus();
    });
    form.addEventListener('submit', (e) => { e.preventDefault(); generar(texto.value.trim()); });
    [$('obsPdfCerrar'), $('obsPdfCancelar')].forEach((b) => b.addEventListener('click', cerrar));
    modal.addEventListener('click', (e) => { if (e.target === modal) cerrar(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && href) cerrar(); });
})();
