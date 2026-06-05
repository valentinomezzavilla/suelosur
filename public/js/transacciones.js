(function() {
    if (!document.getElementById('modal-transaccion')) return;

    document.querySelectorAll('.btn-ver-transaccion').forEach(btn => {
        btn.addEventListener('click', () => {
            document.getElementById('modal-t-id').textContent = '#' + btn.dataset.id;
            document.getElementById('modal-t-tipo').textContent = btn.dataset.tipo;
            document.getElementById('modal-t-cliente').textContent = btn.dataset.cliente;
            document.getElementById('modal-t-descripcion').textContent = btn.dataset.descripcion;
            document.getElementById('modal-t-fecha').textContent = btn.dataset.fecha;
            document.getElementById('modal-t-monto').textContent = '$' + Number(btn.dataset.monto).toLocaleString('es-AR');
            document.getElementById('modal-t-metodo-pago').textContent = btn.dataset.metodoPago;
            document.getElementById('modal-transaccion').style.display = 'flex';
            document.body.style.overflow = 'hidden';
        });
    });

    function cerrarModal() {
        document.getElementById('modal-transaccion').style.display = 'none';
        document.body.style.overflow = '';
    }
    document.getElementById('cerrarModalTransaccion')?.addEventListener('click', cerrarModal);
    document.getElementById('cerrarModalTransaccionBtn')?.addEventListener('click', cerrarModal);
    document.getElementById('modal-transaccion')?.addEventListener('click', e => {
        if (e.target === e.currentTarget) cerrarModal();
    });
})();
