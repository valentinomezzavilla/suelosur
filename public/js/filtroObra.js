// Filtro por obra, con una o varias obras (views/partials/filtro_obras.ejs).
// El botón muestra lo elegido y abre la lista de obras con casillas; cada casilla marcada
// viaja en el form como "obra" (ninguna = todas las obras). Con muchas obras, un buscador
// filtra la lista. Si el contenedor tiene data-dinamico, al elegir un cliente en el buscador
// (buscarCliente.js) carga sus obras; al sacar el cliente se deshabilita.
(function () {
    const cajas = document.querySelectorAll('[data-filtro-obras]');
    if (!cajas.length) return;

    const normalizar = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

    function armar(caja) {
        const boton = caja.querySelector('.filtro-obras__boton');
        const texto = caja.querySelector('.filtro-obras__texto');
        const panel = caja.querySelector('.filtro-obras__panel');
        const lista = caja.querySelector('.filtro-obras__lista');
        const buscar = caja.querySelector('.filtro-obras__buscar');
        const vacio = caja.querySelector('.filtro-obras__vacio');
        const cuenta = caja.querySelector('.filtro-obras__cuenta');
        const limpiar = caja.querySelector('.filtro-obras__limpiar');
        const buscadorDesde = Number(caja.dataset.buscadorDesde) || 7;
        const casillas = () => [...lista.querySelectorAll('input[type="checkbox"]')];
        const nombreDe = (c) => c.parentElement.textContent.trim();

        // Texto del botón, contador y "Desmarcar todas" según lo marcado
        function resumir() {
            const todas = casillas();
            const marcadas = todas.filter(c => c.checked).map(nombreDe);
            texto.textContent = !marcadas.length ? 'Todas las obras'
                : marcadas.length === 1 ? marcadas[0]
                : `${marcadas.length} obras: ${marcadas.join(', ')}`;
            boton.title = marcadas.length > 1 ? marcadas.join(' · ') : '';
            cuenta.textContent = marcadas.length
                ? `${marcadas.length} de ${todas.length} marcada${marcadas.length === 1 ? '' : 's'}`
                : 'Ninguna marcada: se ven todas';
            limpiar.disabled = !marcadas.length;
        }

        function filtrar() {
            const q = normalizar(buscar.value);
            let visibles = 0;
            casillas().forEach(c => {
                const ver = !q || normalizar(nombreDe(c)).includes(q);
                c.parentElement.hidden = !ver;
                if (ver) visibles++;
            });
            vacio.hidden = visibles > 0;
        }

        function abrir() {
            panel.hidden = false;
            boton.setAttribute('aria-expanded', 'true');
            if (!buscar.hidden) buscar.focus();
        }

        function cerrar() {
            if (panel.hidden) return;
            panel.hidden = true;
            boton.setAttribute('aria-expanded', 'false');
            if (buscar.value) { buscar.value = ''; filtrar(); }
        }

        function opcion(o) {
            const label = document.createElement('label');
            label.className = 'filtro-obras__opcion';
            const chk = document.createElement('input');
            chk.type = 'checkbox';
            chk.name = 'obra';
            chk.value = o.clave;
            const span = document.createElement('span');
            span.textContent = o.nombre;
            label.append(chk, span);
            return label;
        }

        function cargar(obras) {
            lista.replaceChildren(...obras.map(opcion));
            buscar.value = '';
            buscar.hidden = obras.length < buscadorDesde;
            vacio.hidden = true;
            boton.disabled = false;
            resumir();
        }

        function deshabilitar(mensaje) {
            cerrar();
            lista.replaceChildren();
            boton.disabled = true;
            boton.title = '';
            texto.textContent = mensaje;
        }

        boton.addEventListener('click', () => (panel.hidden ? abrir() : cerrar()));
        lista.addEventListener('change', resumir);
        buscar.addEventListener('input', filtrar);
        // Enter en el buscador no envía el formulario de filtros
        buscar.addEventListener('keydown', (e) => { if (e.key === 'Enter') e.preventDefault(); });
        limpiar.addEventListener('click', () => {
            casillas().forEach(c => { c.checked = false; });
            resumir();
        });
        // Se cierra al hacer clic afuera, con Escape o al salir con Tab
        document.addEventListener('click', (e) => { if (!caja.contains(e.target)) cerrar(); });
        caja.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && !panel.hidden) {
                e.preventDefault();
                e.stopPropagation();
                cerrar();
                boton.focus();
            }
        });
        caja.addEventListener('focusout', (e) => { if (e.relatedTarget && !caja.contains(e.relatedTarget)) cerrar(); });

        if (!caja.hasAttribute('data-dinamico')) return;
        document.addEventListener('clienteSeleccionado', async (e) => {
            const id = e.detail && e.detail.id;
            if (!id) return;
            deshabilitar('Cargando obras...');
            try {
                const resp = await fetch(`/clientes/api/${encodeURIComponent(id)}/obras`);
                const obras = await resp.json();
                if (!Array.isArray(obras) || !obras.length) { deshabilitar('El cliente no tiene obras cargadas'); return; }
                cargar(obras);
            } catch (_) {
                deshabilitar('No se pudieron cargar las obras');
            }
        });
        document.addEventListener('clienteDeseleccionado', () => deshabilitar('Elegí un cliente para ver sus obras'));
    }

    cajas.forEach(armar);
})();
