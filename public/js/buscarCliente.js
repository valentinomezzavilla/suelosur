// Búsqueda de clientes con autocomplete (reutilizable en varios formularios)
(function () {
    const input           = document.getElementById('buscarClienteInput');
    const dropdown        = document.getElementById('buscarClienteDropdown');
    const btnMostrarCrear = document.getElementById('btnMostrarCrearCliente');
    const divSeleccionado = document.getElementById('clienteSeleccionado');
    const spanNombre      = document.getElementById('clienteSeleccionadoNombre');
    const btnCambiar      = document.getElementById('btnCambiarCliente');
    const divCrear        = document.getElementById('crearClienteInline');
    const btnCrear        = document.getElementById('btnCrearClienteInline');
    const hiddenId        = document.getElementById('inputClienteId');
    const hiddenNombre    = document.getElementById('inputClienteNombre');
    const opcionCC        = document.getElementById('opcionCuentaCorriente');

    if (!input) return;

    let clienteActual = null;
    let timer = null;
    let ultimoTermino = '';

    function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }

    function ocultarDropdown() { dropdown.style.display = 'none'; dropdown.innerHTML = ''; }

    function seleccionarCliente(c) {
        clienteActual = c;
        hiddenId.value     = c.id;
        hiddenNombre.value = c.nombreCompleto;
        const prefijo = c.numero != null ? `#${c.numero} — ` : '';
        spanNombre.textContent = prefijo + c.nombreCompleto;

        ocultarDropdown();
        input.value = '';
        if (divCrear)  divCrear.style.display = 'none';
        divSeleccionado.style.display = 'flex';

        if (opcionCC) {
            opcionCC.style.display = c.cuentaCorriente ? '' : 'none';
            const select = document.getElementById('metodoPago');
            if (select && select.value === 'cuenta_corriente' && !c.cuentaCorriente) select.value = 'efectivo';
        }
        document.dispatchEvent(new CustomEvent('clienteSeleccionado', { detail: c }));
    }

    function resetBusqueda() {
        clienteActual = null;
        hiddenId.value = '';
        hiddenNombre.value = '';
        divSeleccionado.style.display = 'none';
        if (divCrear) divCrear.style.display = 'none';
        ocultarDropdown();
        input.value = '';
        if (opcionCC) opcionCC.style.display = 'none';
        document.dispatchEvent(new CustomEvent('clienteDeseleccionado'));
    }

    function renderResultados(data, termino) {
        if (!data.length) {
            dropdown.innerHTML = `<li class="autocomplete-empty">Sin resultados — <button type="button" class="autocomplete-crear">+ Crear cliente</button></li>`;
            dropdown.style.display = 'block';
            dropdown.querySelector('.autocomplete-crear')?.addEventListener('click', () => abrirCrear(termino));
            return;
        }
        dropdown.innerHTML = data.map((c, i) => {
            const num = c.numero != null ? `#${c.numero}` : '';
            const dni = c.dni ? ` · DNI ${esc(c.dni)}` : '';
            const tel = c.telefono ? ` · ${esc(c.telefono)}` : '';
            return `<li class="autocomplete-item" data-i="${i}">
                <span class="autocomplete-item__nombre">${esc(c.nombreCompleto)}</span>
                <span class="autocomplete-item__meta">${num}${dni}${tel}</span>
            </li>`;
        }).join('');
        dropdown.style.display = 'block';
        dropdown.querySelectorAll('.autocomplete-item').forEach(li => {
            li.addEventListener('mousedown', (e) => { e.preventDefault(); seleccionarCliente(data[Number(li.dataset.i)]); });
        });
    }

    async function buscar(termino) {
        try {
            const resp = await fetch(`/clientes/api/buscar?q=${encodeURIComponent(termino)}`);
            const data = await resp.json();
            if (input.value.trim() !== termino) return; // respuesta vieja
            renderResultados(Array.isArray(data) ? data : [], termino);
        } catch (_) {
            dropdown.innerHTML = '<li class="autocomplete-empty">Error al buscar</li>';
            dropdown.style.display = 'block';
        }
    }

    input.addEventListener('input', () => {
        const t = input.value.trim();
        ultimoTermino = t;
        clearTimeout(timer);
        if (t.length < 1) { ocultarDropdown(); return; }
        timer = setTimeout(() => buscar(t), 250);
    });

    input.addEventListener('focus', () => { if (input.value.trim()) buscar(input.value.trim()); });
    input.addEventListener('blur', () => setTimeout(ocultarDropdown, 150));
    input.addEventListener('keydown', (e) => { if (e.key === 'Escape') ocultarDropdown(); });

    function abrirCrear(termino) {
        ocultarDropdown();
        if (!divCrear) return;
        divCrear.style.display = 'block';
        const parts = (termino || '').split(' ');
        const n = document.getElementById('nuevoClienteNombre');
        const a = document.getElementById('nuevoClienteApellido');
        if (n && parts[0] && !/^\d+$/.test(parts[0])) n.value = parts[0];
        if (a && parts.length > 1) a.value = parts.slice(1).join(' ');
    }

    if (btnMostrarCrear) btnMostrarCrear.addEventListener('click', () => abrirCrear(input.value.trim()));
    btnCambiar.addEventListener('click', resetBusqueda);

    if (btnCrear) btnCrear.addEventListener('click', async () => {
        const nombre   = document.getElementById('nuevoClienteNombre').value.trim();
        const apellido = document.getElementById('nuevoClienteApellido').value.trim();
        const telefono = document.getElementById('nuevoClienteTelefono').value.trim();
        const dni      = document.getElementById('nuevoClienteDni').value.trim();
        if (!nombre || !apellido || !telefono) { alert('Nombre, apellido y telefono son obligatorios.'); return; }
        try {
            const resp = await fetch('/clientes/api/crear', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ nombre, apellido, dni, telefono })
            });
            const data = await resp.json();
            if (data.error) { alert(data.error); return; }
            seleccionarCliente(data);
        } catch (_) { alert('Error al crear cliente.'); }
    });

    window.getClienteSeleccionado = () => clienteActual;
    window.resetBusquedaCliente = resetBusqueda;
})();
