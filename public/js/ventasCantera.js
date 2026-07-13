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
        formPrecioTotal.value = checkPrecio.checked ? inputPrecio.value : calcularTotal();
        const formObs = document.getElementById('formObservaciones');
        if (formObs) formObs.value = document.getElementById('obsCantera')?.value?.trim() || '';

        document.getElementById('formCantera').submit();
    });

    renderCarrito();
});
