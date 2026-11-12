// ═══════════════════════════════════════════════════════════════════
// Modal "Agregar / Editar N° de factura" de una operación (views/partials/modal_nro_factura.ejs).
// Lo abre cualquier botón .btn-nro-factura:
//   data-id (operación), data-nombre (OP-0001), data-nro (el número que ya tiene, si lo tiene).
// Se envía por POST a /facturacion/:id/nro-factura y vuelve a la misma pantalla.
// ═══════════════════════════════════════════════════════════════════
(function () {
    const modal = document.getElementById('modal-nro-factura');
    if (!modal) return;
    const $ = (id) => document.getElementById(id);
    const form = $('nroFacturaForm');
    const input = $('nroFacturaInput');
    const confirmar = $('nroFacturaConfirmar');
    let abierto = false;

    function cerrar() { modal.style.display = 'none'; abierto = false; }

    function abrir(boton) {
        const nro = boton.dataset.nro || '';
        $('nroFacturaAccion').textContent = nro ? 'Editar N° de factura' : 'Agregar N° de factura';
        $('nroFacturaNombre').textContent = boton.dataset.nombre || '';
        form.action = '/facturacion/' + encodeURIComponent(boton.dataset.id) + '/nro-factura';
        // Vuelve a esta misma pantalla, con sus filtros y su página
        $('nroFacturaVolver').value = location.pathname + location.search;
        input.value = nro;
        confirmar.disabled = false;
        modal.style.display = 'flex';
        abierto = true;
        input.focus();
        input.select();
    }

    document.addEventListener('click', (e) => {
        const boton = e.target.closest('.btn-nro-factura');
        if (boton) { e.preventDefault(); abrir(boton); }
    });
    [$('nroFacturaCerrar'), $('nroFacturaCancelar')].forEach((b) => b.addEventListener('click', cerrar));
    modal.addEventListener('click', (e) => { if (e.target === modal) cerrar(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && abierto) cerrar(); });
    // El botón se bloquea al enviar: un doble click no lo manda dos veces (appLoader.js además
    // le pone a todo formulario POST un código de envío único)
    form.addEventListener('submit', () => { setTimeout(() => { confirmar.disabled = true; }, 0); });
})();
