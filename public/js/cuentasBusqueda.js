// Cuentas corrientes: el buscador de cliente filtra mientras se escribe. Pide la misma
// página con el texto (y los filtros/orden actuales) y reemplaza solo los resultados,
// así totales, orden y filtros se calculan igual que al enviar el formulario.
(function () {
    const resultados = document.getElementById('cuentasResultados');
    const input = document.querySelector('.tabla-toolbar__row input[name="q"]');
    if (!resultados || !input) return;

    let timer = null;
    let pedido = null;

    function urlCon(texto) {
        const url = new URL(window.location.href);
        if (texto) url.searchParams.set('q', texto); else url.searchParams.delete('q');
        url.searchParams.delete('page');
        return url;
    }

    async function buscar() {
        const url = urlCon(input.value.trim());
        pedido?.abort();
        pedido = new AbortController();
        resultados.style.opacity = '0.6';
        try {
            const res = await fetch(url, { signal: pedido.signal, headers: { 'X-Requested-With': 'fetch' } });
            if (!res.ok) throw new Error(res.status);
            const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
            const nuevos = doc.getElementById('cuentasResultados');
            if (!nuevos) throw new Error('sin resultados');
            resultados.innerHTML = nuevos.innerHTML;
            history.replaceState(null, '', url);
        } catch (e) {
            if (e.name !== 'AbortError') console.error('Búsqueda de cuentas:', e);
        } finally {
            resultados.style.opacity = '';
        }
    }

    input.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(buscar, 250);
    });

    // Al aplicar filtros, mandar también lo que está escrito en el buscador
    document.querySelectorAll('.tabla-toolbar__filtros-form').forEach(form => {
        form.addEventListener('submit', () => {
            let oculto = form.querySelector('input[type="hidden"][name="q"]');
            if (!oculto) {
                oculto = document.createElement('input');
                oculto.type = 'hidden'; oculto.name = 'q';
                form.appendChild(oculto);
            }
            oculto.value = input.value.trim();
            if (!oculto.value) oculto.remove();
        });
    });
})();
