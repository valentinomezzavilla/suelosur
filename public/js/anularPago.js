// ═══════════════════════════════════════════════════════════════════
// Modal "Anular pago" de un pago de cliente (views/partials/modal_anular_pago.ejs).
// Lo abre cualquier botón .btn-anular-pago: data-id (pago), data-codigo, data-cliente, data-monto.
// Trae primero qué va a cambiar (GET /transacciones/pagos/:id/anular/vista-previa) y deja confirmar
// solo con motivo y sin bloqueos; el pago se anula recién con el POST del formulario.
// ═══════════════════════════════════════════════════════════════════
(function () {
    'use strict';
    const modal = document.getElementById('modal-anular-pago');
    if (!modal) return;
    const $ = (id) => document.getElementById(id);
    const form = $('formAnularPago');
    const cargando = $('anularPagoCargando');
    const bloqueos = $('anularPagoBloqueos');
    const resumen = $('anularPagoResumen');
    const lista = $('anularPagoOps');
    const aFavor = $('anularPagoAFavor');
    const saldo = $('anularPagoSaldo');
    const soloCerrar = $('anularPagoSoloCerrar');
    const motivo = $('anularPagoMotivo');
    const confirmar = $('anularPagoConfirmar');
    let pedido = 0;

    const pesos = (n) => '$' + (Math.round((Number(n) || 0) * 100) / 100).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const textoSaldo = (s) => (s < -0.005 ? 'debe ' + pesos(-s) : (s > 0.005 ? 'a favor ' + pesos(s) : 'al día'));

    function limpiar() {
        bloqueos.hidden = true; bloqueos.textContent = '';
        resumen.hidden = true; resumen.textContent = '';
        lista.hidden = true; lista.textContent = '';
        aFavor.hidden = true; aFavor.textContent = '';
        saldo.hidden = true; saldo.textContent = '';
        form.hidden = true; soloCerrar.hidden = true;
        motivo.value = ''; confirmar.disabled = true;
        cargando.hidden = false;
    }

    function cerrar() {
        pedido++;
        modal.style.display = 'none';
        document.body.style.overflow = '';
    }

    function mostrarBloqueos(textos) {
        bloqueos.hidden = false;
        textos.forEach((t) => { const p = document.createElement('div'); p.textContent = t; bloqueos.appendChild(p); });
        soloCerrar.hidden = false;
    }

    function detalleDe(o) {
        let t = o.etiqueta;
        if (o.tipo) t += ' · ' + o.tipo;
        if (o.remito) t += ' · remito ' + String(o.remito).padStart(8, '0');
        if (o.obra) t += ' · ' + o.obra;
        return t + ': ' + pesos(o.quitado);
    }

    async function abrir(boton) {
        const mia = ++pedido;
        const id = boton.dataset.id;
        $('anularPagoCodigo').textContent = boton.dataset.codigo || '';
        $('anularPagoCliente').textContent = (boton.dataset.cliente || '') + ' · ' + pesos(boton.dataset.monto);
        limpiar();
        modal.style.display = 'flex';
        document.body.style.overflow = 'hidden';
        let r;
        try {
            const resp = await fetch('/transacciones/pagos/' + encodeURIComponent(id) + '/anular/vista-previa', { headers: { Accept: 'application/json' }, credentials: 'same-origin' });
            r = await resp.json();
            if (!resp.ok) throw new Error(r.error || 'Error');
        } catch (e) {
            if (mia !== pedido) return;
            cargando.hidden = true;
            mostrarBloqueos(['No se pudo calcular el cambio. Cerrá esta ventana y volvé a intentar.']);
            return;
        }
        if (mia !== pedido) return;
        cargando.hidden = true;
        if (!r.puede) { mostrarBloqueos(r.bloqueos && r.bloqueos.length ? r.bloqueos : ['Este pago no se puede anular.']); return; }

        const ops = r.operaciones || [];
        resumen.hidden = false;
        resumen.textContent = ops.length
            ? (ops.length === 1 ? 'Esta operación vuelve a quedar pendiente de pago:' : 'Estas ' + ops.length + ' operaciones vuelven a quedar pendientes de pago:')
            : 'Ninguna operación vuelve a quedar pendiente: el pago no estaba cubriendo ninguna.';
        ops.forEach((o) => { const li = document.createElement('li'); li.textContent = detalleDe(o); lista.appendChild(li); });
        lista.hidden = !ops.length;
        if (r.aFavorQuitado > 0.005) { aFavor.hidden = false; aFavor.textContent = 'Además se le quitan ' + pesos(r.aFavorQuitado) + ' de saldo a favor al cliente.'; }
        if (r.saldoAntes != null && r.saldoDespues != null) {
            saldo.hidden = false;
            saldo.textContent = 'Saldo del cliente: ' + textoSaldo(r.saldoAntes) + ' → ' + textoSaldo(r.saldoDespues) + '.';
        }
        form.action = '/transacciones/pagos/' + encodeURIComponent(id) + '/anular';
        form.hidden = false;
        motivo.focus();
    }

    document.querySelectorAll('.btn-anular-pago').forEach((b) => b.addEventListener('click', () => abrir(b)));
    motivo.addEventListener('input', () => { confirmar.disabled = !motivo.value.trim(); });
    [$('anularPagoCerrar'), $('anularPagoCerrar2'), $('anularPagoCancelar')].forEach((b) => b.addEventListener('click', cerrar));
    modal.addEventListener('click', (e) => { if (e.target === modal) cerrar(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && modal.style.display !== 'none') cerrar(); });
})();
