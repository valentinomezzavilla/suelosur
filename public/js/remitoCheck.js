// Campo "Remito" de las ventas y alquileres: solo dígitos (hasta 8) y aviso en vivo
// si ese número ya está cargado en otra operación. Es solo informativo — el mismo
// remito puede repetirse a propósito (un papel puede cubrir varias operaciones
// cargadas por separado), así que nunca bloquea el envío del formulario.
document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('[data-remito-check]').forEach((input) => {
        const msg = input.closest('.form-group, .carrito-seccion')?.querySelector('[data-remito-msg]');
        const textoOriginal = msg ? msg.textContent : '';
        let timer = null;
        let pedido = 0;

        function marcar(repetido, texto) {
            if (msg) {
                msg.textContent = repetido ? texto : textoOriginal;
                msg.style.color = repetido ? '#8a4b06' : '';
            }
        }

        input.addEventListener('input', () => {
            input.value = input.value.replace(/\D/g, '').slice(0, 8);
            clearTimeout(timer);
            marcar(false);
            const nro = Number(input.value);
            if (!input.value || !nro) return;
            timer = setTimeout(async () => {
                const mio = ++pedido;
                try {
                    const resp = await fetch('/ventas/api/remito/' + encodeURIComponent(nro));
                    const data = await resp.json();
                    if (mio !== pedido) return; // llegó una respuesta vieja
                    if (data && data.existe) marcar(true, 'Este remito también está cargado en ' + data.op + '.');
                } catch (_) { /* sin red: no pasa nada, es solo informativo */ }
            }, 300);
        });
    });
});
