// Campo "Remito" de las ventas: solo dígitos (hasta 8) y aviso en vivo si ese número
// ya está cargado en otra operación. El servidor vuelve a validar al guardar; esto
// solo evita perder el formulario (o el carrito) por un remito repetido.
document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('[data-remito-check]').forEach((input) => {
        const msg = input.closest('.form-group, .carrito-seccion')?.querySelector('[data-remito-msg]');
        const textoOriginal = msg ? msg.textContent : '';
        let timer = null;
        let pedido = 0;

        function marcar(invalido, texto) {
            input.dataset.invalido = invalido ? '1' : '';
            input.dataset.mensaje = invalido ? texto : '';
            if (msg) {
                msg.textContent = invalido ? texto : textoOriginal;
                msg.style.color = invalido ? 'var(--bs-danger, #b91c1c)' : '';
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
                    if (data && data.existe) marcar(true, 'El remito ' + nro + ' ya está cargado en ' + data.op + '.');
                } catch (_) { /* sin red: valida el servidor al guardar */ }
            }, 300);
        });
    });
});
