// busqueda y seleccion de clientes (reutilizable en varios formularios)
(function () {
    const btnBuscar           = document.getElementById('btnBuscarCliente');
    const btnMostrarCrear     = document.getElementById('btnMostrarCrearCliente');
    const inputId             = document.getElementById('buscarClienteId');
    const inputDni            = document.getElementById('buscarClienteDni');
    const inputNombre         = document.getElementById('buscarClienteNombre');
    const divResultado        = document.getElementById('buscarClienteResultado');
    const divSeleccionado     = document.getElementById('clienteSeleccionado');
    const spanNombre          = document.getElementById('clienteSeleccionadoNombre');
    const btnCambiar          = document.getElementById('btnCambiarCliente');
    const divCrear            = document.getElementById('crearClienteInline');
    const btnCrear            = document.getElementById('btnCrearClienteInline');
    const hiddenId            = document.getElementById('inputClienteId');
    const hiddenNombre        = document.getElementById('inputClienteNombre');
    const opcionCC            = document.getElementById('opcionCuentaCorriente');

    if (!btnBuscar) return;

    if (btnMostrarCrear) {
        btnMostrarCrear.addEventListener('click', () => {
            divResultado.style.display = 'none';
            divCrear.style.display = 'block';
        });
    }

    let clienteActual = null;

    function seleccionarCliente(c) {
        clienteActual = c;
        hiddenId.value     = c.id;
        hiddenNombre.value = c.nombreCompleto;
        const prefijo = c.numero != null ? `#${c.numero} — ` : '';
        spanNombre.textContent = prefijo + c.nombreCompleto;

        divResultado.style.display    = 'none';
        divCrear.style.display        = 'none';
        divSeleccionado.style.display = 'flex';

        // muestro la opcion de cuenta corriente solo si el cliente la tiene habilitada
        if (opcionCC) {
            opcionCC.style.display = c.cuentaCorriente ? '' : 'none';
            const select = document.getElementById('metodoPago');
            if (select && select.value === 'cuenta_corriente' && !c.cuentaCorriente) {
                select.value = 'efectivo';
            }
        }

        document.dispatchEvent(new CustomEvent('clienteSeleccionado', { detail: c }));
    }

    function resetBusqueda() {
        clienteActual = null;
        hiddenId.value     = '';
        hiddenNombre.value = '';
        divSeleccionado.style.display = 'none';
        divResultado.style.display    = 'none';
        divCrear.style.display        = 'none';
        inputId.value     = '';
        inputDni.value    = '';
        inputNombre.value = '';
        if (opcionCC) opcionCC.style.display = 'none';
        document.dispatchEvent(new CustomEvent('clienteDeseleccionado'));
    }

    btnBuscar.addEventListener('click', async () => {
        const id     = inputId.value.trim();
        const dni    = inputDni.value.trim();
        const nombre = inputNombre.value.trim();

        if (!id && !dni && !nombre) {
            divResultado.innerHTML = '<p class="form-hint">Ingresa al menos un campo para buscar.</p>';
            divResultado.style.display = 'block';
            return;
        }

        const params = new URLSearchParams();
        if (id)     params.set('id', id);
        if (dni)    params.set('dni', dni);
        if (nombre) params.set('nombre', nombre);

        try {
            const resp = await fetch(`/clientes/api/buscar?${params}`);
            const data = await resp.json();

            divCrear.style.display = 'none';

            if (data.length === 0) {
                divResultado.innerHTML = '<p class="form-hint">No se encontraron clientes.</p>';
                divResultado.style.display = 'block';
                divCrear.style.display = 'block';
                // pre-lleno el form de crear con lo que busco
                if (nombre) {
                    const parts = nombre.split(' ');
                    const nuevoNombreInput = document.getElementById('nuevoClienteNombre');
                    const nuevoApellidoInput = document.getElementById('nuevoClienteApellido');
                    if (nuevoNombreInput) nuevoNombreInput.value = parts[0] || '';
                    if (nuevoApellidoInput) nuevoApellidoInput.value = parts.slice(1).join(' ') || '';
                }
                if (dni) {
                    const nuevoDniInput = document.getElementById('nuevoClienteDni');
                    if (nuevoDniInput) nuevoDniInput.value = dni;
                }
            } else if (data.length === 1) {
                seleccionarCliente(data[0]);
            } else {
                // varios resultados, muestro lista para elegir
                let html = '<p class="form-hint">Se encontraron varios clientes:</p><ul class="buscar-cliente__lista">';
                data.forEach(c => {
                    const numStr = c.numero != null ? `#${c.numero} ` : '';
                    html += `<li>
                        <button type="button" class="btn-seleccionar-cliente btn-secondary btn-sm"
                            data-cliente='${JSON.stringify(c).replace(/'/g, "&#39;")}'>
                            ${numStr}${c.nombreCompleto} ${c.dni ? '(DNI: ' + c.dni + ')' : ''} — ${c.telefono || 'sin tel.'}
                        </button>
                    </li>`;
                });
                html += '</ul>';
                divResultado.innerHTML = html;
                divResultado.style.display = 'block';

                divResultado.querySelectorAll('.btn-seleccionar-cliente').forEach(btn => {
                    btn.addEventListener('click', () => {
                        const c = JSON.parse(btn.dataset.cliente);
                        seleccionarCliente(c);
                    });
                });
            }
        } catch (err) {
            divResultado.innerHTML = '<p class="form-hint" style="color:var(--danger)">Error al buscar clientes.</p>';
            divResultado.style.display = 'block';
        }
    });

    btnCambiar.addEventListener('click', resetBusqueda);

    // crear cliente desde el mismo formulario sin ir a otra pagina
    btnCrear.addEventListener('click', async () => {
        const nombre   = document.getElementById('nuevoClienteNombre').value.trim();
        const apellido = document.getElementById('nuevoClienteApellido').value.trim();
        const telefono = document.getElementById('nuevoClienteTelefono').value.trim();
        const dni      = document.getElementById('nuevoClienteDni').value.trim();

        if (!nombre || !apellido || !telefono) {
            alert('Nombre, apellido y telefono son obligatorios.');
            return;
        }

        try {
            const resp = await fetch('/clientes/api/crear', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ nombre, apellido, dni, telefono })
            });
            const data = await resp.json();
            if (data.error) {
                alert(data.error);
                return;
            }
            seleccionarCliente(data);
        } catch (err) {
            alert('Error al crear cliente.');
        }
    });

    // expongo funciones para que otros scripts puedan acceder al cliente seleccionado
    window.getClienteSeleccionado = () => clienteActual;
    window.resetBusquedaCliente = resetBusqueda;
})();
