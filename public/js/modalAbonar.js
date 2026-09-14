(function() {
    const modalAbonar = document.getElementById('modal-abonar');
    if (!modalAbonar) return;
    const inputMonto = document.getElementById('inputMonto');
    let deudaActual = 0;

    const inputDescripcion = document.getElementById('inputDescripcionAbonar');
    const refConcepto      = document.getElementById('modal-abonar-concepto');
    const labelDeuda       = document.getElementById('modal-abonar-deuda-label');
    const btnPagarTotal    = document.getElementById('btnPagarTotal');

    document.querySelectorAll('.btn-abonar').forEach(btn => {
        btn.addEventListener('click', () => {
            deudaActual = Number(btn.dataset.deuda);
            document.getElementById('modal-abonar-nombre').textContent = btn.dataset.nombre;
            document.getElementById('modal-abonar-deuda').textContent  = '$' + deudaActual.toLocaleString('es-AR');
            // Saldo individual de una operación puntual (desde el ledger): precarga el
            // monto exacto de esa fila y deja la referencia para no tener que tipear nada.
            // Se distingue de "Saldar deuda total" (sin data-descripcion) por el rótulo
            // y por ocultar "Usar el total", que ahí no tiene sentido (ya está precargado).
            const concepto = btn.dataset.descripcion || '';
            if (inputDescripcion) inputDescripcion.value = concepto;
            if (refConcepto) {
                refConcepto.textContent = concepto ? `Concepto: ${concepto}` : '';
                refConcepto.classList.toggle('d-none', !concepto);
            }
            if (labelDeuda) labelDeuda.textContent = concepto ? 'Importe de esta operación' : 'Deuda total';
            if (btnPagarTotal) btnPagarTotal.classList.toggle('d-none', !!concepto);
            inputMonto.value = concepto ? deudaActual : '';
            inputMonto.max   = deudaActual;
            document.getElementById('formAbonar').action = `/clientes/${btn.dataset.id}/abonar`;
            modalAbonar.style.display = 'flex';
            document.body.style.overflow = 'hidden';
            inputMonto.focus();
        });
    });

    // boton "pagar todo"
    btnPagarTotal?.addEventListener('click', () => {
        inputMonto.value = deudaActual;
    });

    function cerrarAbonar() {
        modalAbonar.style.display = 'none';
        document.body.style.overflow = '';
    }
    document.getElementById('cerrarModalAbonar')?.addEventListener('click', cerrarAbonar);
    document.getElementById('cancelarModalAbonar')?.addEventListener('click', cerrarAbonar);
    modalAbonar?.addEventListener('click', e => { if (e.target === e.currentTarget) cerrarAbonar(); });
})();
