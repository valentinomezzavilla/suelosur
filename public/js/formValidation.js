// validacion generica de formularios
function validarFormulario(form, camposRequeridos) {
    let valido = true;
    form.querySelectorAll('.field-error').forEach(el => el.classList.remove('field-error'));
    form.querySelectorAll('.field-error-msg').forEach(el => el.remove());

    camposRequeridos.forEach(selector => {
        const campo = form.querySelector(selector);
        if (!campo) return;
        if (campo.offsetParent === null) return; // skip campos ocultos

        const valor = campo.value?.trim();
        if (!valor) {
            valido = false;
            campo.classList.add('field-error');
            const msg = document.createElement('span');
            msg.className = 'field-error-msg';
            msg.textContent = 'Este campo es obligatorio';
            campo.parentNode.appendChild(msg);
        }
    });

    return valido;
}

// limpio el error cuando el usuario empieza a escribir
document.addEventListener('input', (e) => {
    if (e.target.classList.contains('field-error')) {
        e.target.classList.remove('field-error');
        const msg = e.target.parentNode.querySelector('.field-error-msg');
        if (msg) msg.remove();
    }
});

document.addEventListener('change', (e) => {
    if (e.target.classList.contains('field-error')) {
        e.target.classList.remove('field-error');
        const msg = e.target.parentNode.querySelector('.field-error-msg');
        if (msg) msg.remove();
    }
});
