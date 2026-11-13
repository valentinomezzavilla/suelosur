// ═══════════════════════════════════════════════════════════════════
// Modal "Marcar pendiente" / "Marcar como pagada" una operación
// (views/partials/modal_estado_pago.ejs). Lo abre cualquier botón .btn-estado-pago:
//   data-id (operación), data-accion ('pendiente' | 'pagada'), data-nombre.
// Trae primero qué va a cambiar (GET /estado-pago/:id/vista-previa) y deja confirmar solo si se
// puede; el cambio se guarda recién con el POST del formulario.
// ═══════════════════════════════════════════════════════════════════
(function () {
    const modal = document.getElementById('modal-estado-pago');
    if (!modal) return;
    const $ = (id) => document.getElementById(id);
    const form = $('estadoPagoForm');
    const bloqueos = $('estadoPagoBloqueos');
    const resumen = $('estadoPagoResumen');
    const lineas = $('estadoPagoLineas');
    const nota = $('estadoPagoNota');
    const saldo = $('estadoPagoSaldo');
    const cargando = $('estadoPagoCargando');
    const motivoGrupo = $('estadoPagoMotivoGrupo');
    const cobroGrupo = $('estadoPagoCobroGrupo');
    const motivo = $('estadoPagoMotivo');
    const metodo = $('estadoPagoMetodo');
    const confirmar = $('estadoPagoConfirmar');
    const soloCerrar = $('estadoPagoSoloCerrar');
    let actual = null;
    let pedido = 0;

    const pesos = (n) => '$' + (Math.round((Number(n) || 0) * 100) / 100).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const textoSaldo = (s) => (s < -0.005 ? 'debe ' + pesos(-s) : (s > 0.005 ? 'a favor ' + pesos(s) : 'al día'));

    function cerrar() { modal.style.display = 'none'; actual = null; }

    function limpiar() {
        bloqueos.hidden = true; bloqueos.textContent = '';
        resumen.hidden = true; resumen.textContent = '';
        lineas.hidden = true; lineas.innerHTML = '';
        nota.hidden = true; nota.textContent = '';
        saldo.hidden = true; saldo.textContent = '';
        form.hidden = true; soloCerrar.hidden = true;
        motivoGrupo.hidden = true; cobroGrupo.hidden = true;
        motivo.required = false; motivo.value = '';
        confirmar.disabled = false;
        cargando.hidden = false;
    }

    async function cargarVistaPrevia() {
        const mia = ++pedido;
        cargando.hidden = false;
        bloqueos.hidden = true; resumen.hidden = true; lineas.hidden = true; nota.hidden = true; saldo.hidden = true; form.hidden = true; soloCerrar.hidden = true;
        let r;
        try {
            const url = '/estado-pago/' + encodeURIComponent(actual.id) + '/vista-previa?accion=' + actual.accion +
                (actual.accion === 'pagada' ? '&metodo_pago=' + encodeURIComponent(metodo.value) : '');
            const resp = await fetch(url, { headers: { Accept: 'application/json' }, credentials: 'same-origin' });
            r = await resp.json();
            if (!resp.ok) throw new Error(r.error || 'Error');
        } catch (e) {
            if (mia !== pedido) return;
            cargando.hidden = true;
            bloqueos.hidden = false; bloqueos.textContent = 'No se pudo calcular el cambio. Cerrá esta ventana y volvé a intentar.';
            soloCerrar.hidden = false;
            return;
        }
        if (mia !== pedido) return;
        cargando.hidden = true;
        if (r.bloqueos && r.bloqueos.length) {
            bloqueos.hidden = false;
            bloqueos.innerHTML = '';
            r.bloqueos.forEach((t) => { const p = document.createElement('div'); p.textContent = t; bloqueos.appendChild(p); });
        }
        if (r.puede) {
            // Con resumen (marcar pendiente): una frase clara, solo los pagos que cambian y una nota
            // para los que no; sin resumen, el detalle completo de siempre
            const x = r.resumen;
            const conResumen = !!(x && x.quitado > 0.005);
            const detalle = conResumen ? (x.pagosQueCambian || []) : (r.lineas || []);
            if (conResumen) {
                resumen.hidden = false;
                resumen.textContent = 'Se le quitan ' + pesos(x.quitado) + ' de pagos a esta operación y el cliente vuelve a deberlos.';
                if (x.pagosSinCambio > 0) {
                    nota.hidden = false;
                    nota.textContent = (x.pagosSinCambio === 1 ? 'Otro pago del cliente no cambia' : 'Otros ' + x.pagosSinCambio + ' pagos del cliente no cambian') +
                        ' de monto: solo se deja escrito a qué operaciones va cada uno, para que no se corran a esta operación al quedar pendiente.';
                }
            }
            detalle.forEach((t) => { const li = document.createElement('li'); li.textContent = t; lineas.appendChild(li); });
            lineas.hidden = !detalle.length;
            if (r.saldoAntes != null && r.saldoDespues != null && Math.abs(r.saldoAntes - r.saldoDespues) > 0.005) {
                saldo.hidden = false;
                saldo.textContent = 'Saldo del cliente: ' + textoSaldo(r.saldoAntes) + ' → ' + textoSaldo(r.saldoDespues);
            }
            form.hidden = false;
        } else {
            soloCerrar.hidden = false;
        }
    }

    function abrir(boton) {
        actual = { id: boton.dataset.id, accion: boton.dataset.accion };
        limpiar();
        const pendiente = actual.accion === 'pendiente';
        $('estadoPagoAccion').textContent = pendiente ? 'Marcar pendiente de pago' : 'Marcar como pagada';
        $('estadoPagoNombre').textContent = boton.dataset.nombre || '';
        form.action = '/estado-pago/' + encodeURIComponent(actual.id) + '/marcar-' + actual.accion;
        motivoGrupo.hidden = !pendiente;
        motivo.required = pendiente;
        cobroGrupo.hidden = pendiente;
        confirmar.className = 'btn ' + (pendiente ? 'btn-danger' : 'btn-success');
        confirmar.textContent = pendiente ? 'Marcar pendiente' : 'Marcar como pagada';
        modal.style.display = 'flex';
        cargarVistaPrevia();
    }

    document.addEventListener('click', (e) => {
        const boton = e.target.closest('.btn-estado-pago');
        if (boton) { e.preventDefault(); abrir(boton); }
    });
    ['estadoPagoCerrar', 'estadoPagoCancelar', 'estadoPagoCerrar2'].forEach((id) => $(id).addEventListener('click', cerrar));
    modal.addEventListener('click', (e) => { if (e.target === modal) cerrar(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && actual) cerrar(); });
    metodo.addEventListener('change', () => { if (actual && actual.accion === 'pagada') cargarVistaPrevia(); });
    // El botón se bloquea al enviar: un doble click no registra dos veces (appLoader.js además
    // le pone a todo formulario POST un código de envío único)
    form.addEventListener('submit', (e) => {
        if (motivo.required && !motivo.value.trim()) { e.preventDefault(); motivo.focus(); return; }
        setTimeout(() => { confirmar.disabled = true; }, 0);
    });
})();
