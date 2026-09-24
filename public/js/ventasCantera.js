document.addEventListener('DOMContentLoaded', () => {
    const container      = document.getElementById('cartItemsContainer');
    if (!container) return;
    const buttons        = document.querySelectorAll('.addToCart');
    const totalBar       = document.getElementById('cartTotal');
    const totalValor     = document.getElementById('cartTotalValor');
    const actionsDiv     = document.getElementById('cartActions');
    const seccionCliente = document.getElementById('seccionCliente');
    const precioSection  = document.getElementById('precioEditableSection');
    const btnConfirmar   = document.getElementById('btnConfirmarCantera');
    const btnLimpiar     = document.getElementById('btnLimpiarCarrito');
    const checkParticular = document.getElementById('checkParticular');
    const busquedaWrapper = document.getElementById('busquedaClienteWrapper');
    const checkPrecio    = document.getElementById('checkPrecioEditable');
    const inputPrecio    = document.getElementById('precioEditableInput');
    // Panel de carrito (mobile)
    const aside          = document.getElementById('carrito');
    const cartToggle     = document.getElementById('cartToggle');
    const cartClose      = document.getElementById('cartClose');
    const cartBackdrop   = document.getElementById('cartBackdrop');
    const cartCount      = document.getElementById('cartCount');

    const abrirCarrito  = () => { aside && aside.classList.add('is-open'); cartBackdrop && cartBackdrop.classList.add('is-open'); document.body.style.overflow = 'hidden'; };
    const cerrarCarrito = () => { aside && aside.classList.remove('is-open'); cartBackdrop && cartBackdrop.classList.remove('is-open'); document.body.style.overflow = ''; };
    if (cartToggle)   cartToggle.addEventListener('click', abrirCarrito);
    if (cartClose)    cartClose.addEventListener('click', cerrarCarrito);
    if (cartBackdrop) cartBackdrop.addEventListener('click', cerrarCarrito);

    let carrito = [];

    // Contenedor: va de a UNO por operación y se cobra días × precio por día del rango
    // en que caen esos días (el servidor recalcula igual al confirmar).
    function rangoParaDias(rangos, dias) {
        const n = Number(dias);
        if (!Number.isInteger(n) || n < 1) return null;
        return (rangos || []).find(r => n >= Number(r.dias_desde) && (r.dias_hasta == null || n <= Number(r.dias_hasta))) || null;
    }
    function cotizarContenedor(item) {
        const r = rangoParaDias(item.rangos, item.dias);
        item.precioDia = r ? Number(r.precio_dia) : 0;
        item.precio    = r ? item.dias * item.precioDia : 0;
        item.valido    = !!r;
    }
    function textoContenedor(item) {
        if (!item.valido) return '<span class="text-danger">Sin precio para esos días</span>';
        return `${item.dias} día${item.dias === 1 ? '' : 's'} × $${item.precioDia.toLocaleString('es-AR')} = <b>$${item.precio.toLocaleString('es-AR')}</b>`;
    }

    function actualizarContador() {
        if (!cartCount) return;
        const n = carrito.reduce((a, p) => a + p.cantidad, 0);
        cartCount.textContent = n;
        cartCount.classList.toggle('cart-count--has', n > 0);
    }

    function calcularTotal() {
        return carrito.reduce((acc, p) => acc + p.precio * p.cantidad, 0);
    }

    function renderCarrito() {
        container.innerHTML = '';
        actualizarContador();

        if (carrito.length === 0) {
            container.innerHTML = '<div class="cart_empty">No hay items en el carrito</div>';
            totalBar.style.display = 'none';
            actionsDiv.style.display = 'none';
            seccionCliente.style.display = 'none';
            precioSection.style.display = 'none';
            btnConfirmar.disabled = true;
            return;
        }

        actionsDiv.style.display = 'flex';
        seccionCliente.style.display = 'block';
        precioSection.style.display = 'block';

        carrito.forEach(producto => {
            const div = document.createElement('div');
            div.className = 'cart-item';
            if (producto.contenedor) {
                // Cantidad fija en 1: lo que se edita son los días
                div.innerHTML = `
                <div class="cart-item__info">
                    <span class="cart-item__nombre">${producto.nombre} x1</span>
                    <span class="cart-item__meta" data-meta-contenedor>${textoContenedor(producto)}</span>
                </div>
                <div class="cart-item__actions">
                    <input type="number" class="input-sm dias-contenedor" data-id="${producto.id}" value="${producto.dias}" min="1" step="1" style="width:4.5rem" aria-label="Días">
                    <span class="cart-item__meta">días</span>
                    <button type="button" class="qty-btn qty-remove" data-id="${producto.id}">✕</button>
                </div>
            `;
                container.appendChild(div);
                return;
            }
            div.innerHTML = `
                <div class="cart-item__info">
                    <span class="cart-item__nombre">${producto.nombre}</span>
                    <span class="cart-item__meta">$${producto.precio.toLocaleString('es-AR')} x ${producto.cantidad} = <b>$${(producto.precio * producto.cantidad).toLocaleString('es-AR')}</b></span>
                </div>
                <div class="cart-item__actions">
                    <button type="button" class="qty-btn qty-minus" data-id="${producto.id}">−</button>
                    <span class="qty-display">${producto.cantidad}</span>
                    <button type="button" class="qty-btn qty-plus" data-id="${producto.id}">+</button>
                    <button type="button" class="qty-btn qty-remove" data-id="${producto.id}">✕</button>
                </div>
            `;
            container.appendChild(div);
        });

        // botones +/-/x
        container.querySelectorAll('.qty-minus').forEach(btn => {
            btn.addEventListener('click', () => {
                const p = carrito.find(x => x.id === btn.dataset.id);
                if (p) { p.cantidad--; if (p.cantidad <= 0) carrito = carrito.filter(x => x.id !== p.id); renderCarrito(); }
            });
        });
        container.querySelectorAll('.qty-plus').forEach(btn => {
            btn.addEventListener('click', () => {
                const p = carrito.find(x => x.id === btn.dataset.id);
                if (p && p.cantidad < p.stock) { p.cantidad++; renderCarrito(); }
            });
        });
        container.querySelectorAll('.qty-remove').forEach(btn => {
            btn.addEventListener('click', () => {
                carrito = carrito.filter(x => x.id !== btn.dataset.id);
                renderCarrito();
            });
        });
        // Días del contenedor: se actualiza en el lugar (sin re-render) para no perder el foco
        container.querySelectorAll('.dias-contenedor').forEach(input => {
            input.addEventListener('input', () => {
                const p = carrito.find(x => x.id === input.dataset.id);
                if (!p) return;
                p.dias = Number(input.value);
                cotizarContenedor(p);
                const meta = input.closest('.cart-item').querySelector('[data-meta-contenedor]');
                if (meta) meta.innerHTML = textoContenedor(p);
                actualizarTotal();
            });
        });

        actualizarTotal();
    }

    function actualizarTotal() {
        const total = calcularTotal();
        totalBar.style.display = 'flex';
        totalValor.textContent = '$' + total.toLocaleString('es-AR');

        if (!checkPrecio.checked) inputPrecio.value = total;

        actualizarBotonConfirmar();
    }

    function actualizarBotonConfirmar() {
        if (carrito.length === 0) { btnConfirmar.disabled = true; return; }
        if (checkParticular.checked) { btnConfirmar.disabled = false; return; }
        const clienteId = document.getElementById('inputClienteId');
        btnConfirmar.disabled = !clienteId || !clienteId.value;
    }

    // agregar al carrito (no deja pasar del stock disponible)
    buttons.forEach(btn => {
        btn.addEventListener('click', () => {
            if (btn.disabled) return;
            const id     = btn.dataset.id;
            const nombre = btn.dataset.nombre;
            if (btn.dataset.contenedor === '1') {
                // Un solo contenedor por operación
                if (carrito.some(p => p.contenedor)) {
                    alert('Solo se puede cargar un contenedor por operación.');
                    return;
                }
                let rangos = [];
                try { rangos = JSON.parse(btn.dataset.rangos || '[]'); } catch (_) {}
                const item = { id, nombre, contenedor: true, rangos, dias: 1, cantidad: 1 };
                cotizarContenedor(item);
                carrito.push(item);
                renderCarrito();
                return;
            }
            const precio = Number(btn.dataset.precio);
            const stock  = Number(btn.dataset.stock);
            const exist  = carrito.find(p => p.id === id);
            if (exist) {
                if (exist.cantidad >= stock) return;
                exist.cantidad++;
            } else {
                carrito.push({ id, nombre, precio, stock, cantidad: 1 });
            }
            renderCarrito();
        });
    });

    btnLimpiar.addEventListener('click', () => {
        if (!confirm('¿Limpiar el carrito?')) return;
        carrito = [];
        renderCarrito();
    });

    checkParticular.addEventListener('change', () => {
        busquedaWrapper.style.display = checkParticular.checked ? 'none' : 'block';
        actualizarBotonConfirmar();
    });

    checkPrecio.addEventListener('change', () => {
        inputPrecio.style.display = checkPrecio.checked ? 'block' : 'none';
        if (!checkPrecio.checked) inputPrecio.value = calcularTotal();
    });

    document.addEventListener('clienteSeleccionado', () => actualizarBotonConfirmar());
    document.addEventListener('clienteDeseleccionado', () => actualizarBotonConfirmar());

    // confirmar venta
    btnConfirmar.addEventListener('click', () => {
        if (carrito.length === 0) return;

        const contInvalido = carrito.find(p => p.contenedor && !p.valido);
        if (contInvalido) {
            alert(`Revisá los días del contenedor: no hay precio para ${contInvalido.dias || 0} día(s).`);
            return;
        }

        const formClienteId    = document.getElementById('formClienteId');
        const formClienteNombre = document.getElementById('formClienteNombre');
        const formItems        = document.getElementById('formItems');
        const formMetodoPago   = document.getElementById('formMetodoPago');
        const formPrecioTotal  = document.getElementById('formPrecioTotal');

        if (checkParticular.checked) {
            formClienteId.value    = '';
            formClienteNombre.value = 'Particular';
        } else {
            formClienteId.value    = document.getElementById('inputClienteId')?.value || '';
            formClienteNombre.value = document.getElementById('inputClienteNombre')?.value || '';
            if (!formClienteNombre.value) {
                alert('Selecciona un cliente o marca como particular.');
                return;
            }
        }

        formItems.value       = JSON.stringify(carrito);
        formMetodoPago.value  = document.getElementById('metodoPago')?.value || 'efectivo';
        const formParaFacturar = document.getElementById('formParaFacturar');
        if (formParaFacturar) formParaFacturar.value = document.getElementById('paraFacturar')?.checked ? '1' : '';
        formPrecioTotal.value = checkPrecio.checked ? inputPrecio.value : calcularTotal();
        const formObs = document.getElementById('formObservaciones');
        if (formObs) formObs.value = document.getElementById('obsCantera')?.value?.trim() || '';
        const formFecha = document.getElementById('formFecha');
        if (formFecha) formFecha.value = document.getElementById('fechaCantera')?.value || '';
        const remitoInput = document.getElementById('remitoCantera');
        if (remitoInput && remitoInput.dataset.invalido === '1') {
            alert(remitoInput.dataset.mensaje || 'Revisá el número de remito.');
            remitoInput.focus();
            return;
        }
        const formRemito = document.getElementById('formRemito');
        if (formRemito) formRemito.value = remitoInput?.value?.trim() || '';

        document.getElementById('formCantera').submit();
    });

    // La fecha arranca en hoy pero se puede mover hacia atrás para cargar ventas viejas
    const fechaCantera = document.getElementById('fechaCantera');
    if (fechaCantera && !fechaCantera.value) fechaCantera.value = new Date().toISOString().slice(0, 10);

    renderCarrito();
});
