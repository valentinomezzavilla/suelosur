(function() {
    const modalUsuario = document.getElementById('modal-nuevo-usuario');
    if (!modalUsuario) return;

    document.getElementById('btnNuevoUsuario').addEventListener('click', () => {
        modalUsuario.style.display = 'flex';
        document.body.style.overflow = 'hidden';
    });

    function cerrarModal() {
        modalUsuario.style.display = 'none';
        document.body.style.overflow = '';
    }
    document.getElementById('cerrarModalUsuario').addEventListener('click', cerrarModal);
    document.getElementById('cancelarModalUsuario').addEventListener('click', cerrarModal);

    // validacion del form
    document.getElementById('formNuevoUsuario').addEventListener('submit', function(e) {
        if (!validarFormulario(this, ['#nombre', '#apellido', '#user', '#password'])) {
            e.preventDefault();
        }
    });

    // mostrar/ocultar contraseña
    document.querySelectorAll('.btn-toggle-pass').forEach(btn => {
        btn.addEventListener('click', () => {
            const input = document.getElementById(btn.dataset.target);
            if (!input) return;
            if (input.type === 'password') {
                input.type = 'text';
                btn.textContent = 'Ocultar';
            } else {
                input.type = 'password';
                btn.textContent = 'Ver';
            }
        });
    });

    // modal editar usuario
    const modalEditar        = document.getElementById('modal-editar-usuario');
    const formEditarUsuario  = document.getElementById('formEditarUsuario');
    const editNombre         = document.getElementById('editNombre');
    const editApellido       = document.getElementById('editApellido');
    const editUser           = document.getElementById('editUser');
    const editRol            = document.getElementById('editRol');
    const editPassword       = document.getElementById('editPassword');
    const editConfirmarPass  = document.getElementById('editConfirmarPass');
    const editConfirmarPassGroup = document.getElementById('editConfirmarPassGroup');
    const errorEditar        = document.getElementById('modal-editar-error');

    document.querySelectorAll('.btn-editar-usuario').forEach(btn => {
        btn.addEventListener('click', () => {
            formEditarUsuario.action = `/configuraciones/usuarios/editar/${btn.dataset.id}`;
            editNombre.value = btn.dataset.nombre || '';
            editApellido.value = btn.dataset.apellido || '';
            editUser.value = btn.dataset.user || '';
            editRol.value = btn.dataset.rol || 'operador';
            editPassword.value = '';
            editConfirmarPass.value = '';
            editConfirmarPassGroup.style.display = 'none';
            errorEditar.style.display = 'none';
            // no se puede cambiar el rol del admin principal (id=1)
            editRol.disabled = btn.dataset.id === '1';
            modalEditar.style.display = 'flex';
            document.body.style.overflow = 'hidden';
            editNombre.focus();
        });
    });

    // si escribe una pass nueva, muestro el campo de confirmacion
    editPassword.addEventListener('input', () => {
        editConfirmarPassGroup.style.display = editPassword.value.length > 0 ? '' : 'none';
        if (editPassword.value.length === 0) editConfirmarPass.value = '';
    });

    function cerrarModalEditar() {
        modalEditar.style.display = 'none';
        document.body.style.overflow = '';
    }
    document.getElementById('cerrarModalEditar').addEventListener('click', cerrarModalEditar);
    document.getElementById('cancelarModalEditar').addEventListener('click', cerrarModalEditar);
    modalEditar.addEventListener('click', e => { if (e.target === e.currentTarget) cerrarModalEditar(); });

    // validacion: las contraseñas tienen que coincidir
    formEditarUsuario.addEventListener('submit', function(e) {
        errorEditar.style.display = 'none';
        if (editPassword.value.length > 0 && editPassword.value !== editConfirmarPass.value) {
            e.preventDefault();
            errorEditar.style.display = 'block';
            editConfirmarPass.focus();
        }
    });

    // toggle para mostrar/ocultar usuarios pausados
    const toggle = document.getElementById('toggleMostrarPausados');
    toggle.addEventListener('change', () => {
        const filas = document.querySelectorAll('#tablaUsuarios tr[data-activo]');
        filas.forEach(fila => {
            if (fila.dataset.activo === 'false') {
                fila.style.display = toggle.checked ? '' : 'none';
            }
        });
    });
})();
