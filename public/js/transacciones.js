(function() {
    if (!document.getElementById('modal-transaccion')) return;

    const PAGO_LABEL = {
        efectivo: 'Efectivo', transferencia: 'Transferencia',
        cheque: 'Cheque', cuenta_corriente: 'Cuenta corriente',
    };

    document.querySelectorAll('.btn-ver-transaccion').forEach(btn => {
        btn.addEventListener('click', () => {
            document.getElementById('modal-t-id').textContent = '#' + btn.dataset.id;
            document.getElementById('modal-t-tipo').textContent = btn.dataset.tipo;
            document.getElementById('modal-t-cliente').textContent = btn.dataset.cliente;
            document.getElementById('modal-t-descripcion').textContent = btn.dataset.descripcion;
            document.getElementById('modal-t-fecha').textContent = btn.dataset.fecha;
            document.getElementById('modal-t-monto').textContent = '$' + Number(btn.dataset.monto).toLocaleString('es-AR');
            const mp = btn.dataset.metodoPago;
            document.getElementById('modal-t-metodo-pago').textContent = PAGO_LABEL[mp] || (mp ? mp : '—');

            // Archivos asociados (remito y remito firmado de la operación)
            const opId = btn.dataset.opId;
            const linksBox = document.getElementById('modal-t-files-links');
            linksBox.innerHTML = '';
            if (opId) {
                const remito = document.createElement('a');
                remito.href = '/remitos/' + opId + '/pdf';
                remito.target = '_blank';
                remito.rel = 'noopener';
                remito.className = 'tx-file-link';
                remito.innerHTML = '📄 Ver remito' + (btn.dataset.nroRemito ? ' N° ' + btn.dataset.nroRemito : '');
                linksBox.appendChild(remito);

                if (btn.dataset.remitoFirmado === '1') {
                    const firmado = document.createElement('a');
                    firmado.href = '/remitos/' + opId + '/firmado';
                    firmado.target = '_blank';
                    firmado.rel = 'noopener';
                    firmado.className = 'tx-file-link tx-file-link--firmado';
                    firmado.innerHTML = '✅ Remito firmado';
                    linksBox.appendChild(firmado);
                }
            } else {
                linksBox.innerHTML = '<span class="tx-files__empty">Sin archivos asociados.</span>';
            }

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
