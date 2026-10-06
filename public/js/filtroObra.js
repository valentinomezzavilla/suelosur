// Filtro por obra: al elegir un cliente (buscarCliente.js) carga sus obras en el
// desplegable #filtroObra y lo habilita; al sacar el cliente lo vuelve a deshabilitar.
(function () {
    const select = document.getElementById('filtroObra');
    if (!select) return;

    function opcion(valor, texto) {
        const o = document.createElement('option');
        o.value = valor;
        o.textContent = texto;
        return o;
    }

    function deshabilitar(texto) {
        select.replaceChildren(opcion('', texto));
        select.disabled = true;
    }

    document.addEventListener('clienteSeleccionado', async (e) => {
        const id = e.detail && e.detail.id;
        if (!id) return;
        deshabilitar('Cargando obras...');
        try {
            const resp = await fetch(`/clientes/api/${encodeURIComponent(id)}/obras`);
            const obras = await resp.json();
            if (!Array.isArray(obras) || !obras.length) { deshabilitar('El cliente no tiene obras cargadas'); return; }
            select.replaceChildren(opcion('', 'Todas las obras'), ...obras.map(o => opcion(o.clave, o.nombre)));
            select.disabled = false;
        } catch (_) {
            deshabilitar('No se pudieron cargar las obras');
        }
    });

    document.addEventListener('clienteDeseleccionado', () => deshabilitar('Elegí un cliente para ver sus obras'));
})();
