// ═══════════════════════════════════════════════════════════════════
// Campos numéricos que admiten decimales (step="any", "0.01", "0.5"): el decimal lo pone solo
// quien escribe una coma o un punto, nunca el navegador.
//   · Flechas ↑/↓ del teclado: suben o bajan de a 1 (1500 → 1501, 2.5 → 3.5), no de a 0.01, y
//     un campo vacío arranca en un entero (con mínimo 0.01 → 1, no 0.01).
//   · Ruedita del mouse sobre el campo seleccionado: no cambia el número (se suelta el campo y
//     la página se desplaza como siempre). Vale para todos los campos numéricos.
//   · Sin las flechitas del costado (CSS, components/_forms-base.scss), que suman de a 0.01.
// Los campos de paso entero (step="1", "100") quedan como siempre.
// ═══════════════════════════════════════════════════════════════════
(function () {
    const esNumero = (el) => el && el.tagName === 'INPUT' && el.type === 'number';
    const pasoDecimal = (el) => {
        const s = String(el.getAttribute('step') || '').trim().toLowerCase();
        if (!s) return false;
        if (s === 'any') return true;
        const n = Number(s);
        return Number.isFinite(n) && !Number.isInteger(n);
    };
    const limite = (el, attr) => {
        const v = el.getAttribute(attr);
        return v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v);
    };

    function pasoEntero(el, sube) {
        const min = limite(el, 'min');
        const max = limite(el, 'max');
        const actual = el.value;
        let nuevo;
        if (actual === '') {
            nuevo = min != null ? Math.max(Math.ceil(min), sube ? 1 : Math.ceil(min)) : (sube ? 1 : 0);
        } else {
            // Mismos decimales que escribió el usuario (2.5 → 3.5), sin errores de coma flotante
            const decimales = (actual.split('.')[1] || '').length;
            nuevo = Number((Number(actual) + (sube ? 1 : -1)).toFixed(decimales));
        }
        // Fuera del mínimo o del máximo: queda como está (no se acomoda a un decimal)
        if ((min != null && nuevo < min) || (max != null && nuevo > max)) return;
        if (String(nuevo) === actual) return;
        el.value = String(nuevo);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
    }

    document.addEventListener('keydown', (e) => {
        const el = e.target;
        if (!esNumero(el) || el.readOnly || el.disabled) return;
        if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
        if (e.altKey || e.ctrlKey || e.metaKey) return;
        if (!pasoDecimal(el)) return;
        e.preventDefault();
        pasoEntero(el, e.key === 'ArrowUp');
    }, true);

    document.addEventListener('wheel', (e) => {
        const el = document.activeElement;
        if (esNumero(el) && e.target === el) el.blur();
    }, { capture: true, passive: true });
})();
