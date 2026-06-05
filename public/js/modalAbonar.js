(function() {
    const modalAbonar = document.getElementById('modal-abonar');
    if (!modalAbonar) return;
    const inputMonto = document.getElementById('inputMonto');
    let deudaActual = 0;

    document.querySelectorAll('.btn-abonar').forEach(btn => {
        btn.addEventListener('click', () => {
            deudaActual = Number(btn.dataset.deuda);
            document.getElementById('modal-abonar-nombre').textContent = btn.dataset.nombre;
            document.getElementById('modal-abonar-deuda').textContent  = '$' + deudaActual.toLocaleString('es-AR');
            inputMonto.value = '';
            inputMonto.max   = deudaActual;
            document.getElementById('formAbonar').action = `/clientes/${btn.dataset.id}/abonar`;
            modalAbonar.style.display = 'flex';
            document.body.style.overflow = 'hidden';
            inputMonto.focus();
        });
    });

    // boton "pagar todo"
    document.getElementById('btnPagarTotal')?.addEventListener('click', () => {
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
