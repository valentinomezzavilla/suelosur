/**
 * signaturePad.js — Pad de firma táctil sobre <canvas>, sin dependencias.
 *
 * Uso:
 *   const pad = SignaturePad(canvasEl);
 *   pad.isEmpty();        // ¿no firmó nada?
 *   pad.clear();          // limpiar
 *   pad.toDataURL();      // PNG en base64 (con fondo blanco)
 *
 * Soporta mouse y touch (Pointer Events). Ajusta la resolución del canvas
 * al tamaño real en pantalla para que el trazo no se vea pixelado.
 */
function SignaturePad(canvas) {
  const ctx = canvas.getContext('2d');
  let drawing = false;
  let dirty = false;
  let last = null;

  function resize() {
    // Conserva el trazo actual al redimensionar
    const prev = dirty ? canvas.toDataURL() : null;
    const ratio = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, rect.width * ratio);
    canvas.height = Math.max(1, rect.height * ratio);
    ctx.scale(ratio, ratio);
    ctx.lineWidth = 2.2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#1f2937';
    if (prev) {
      const img = new Image();
      img.onload = () => ctx.drawImage(img, 0, 0, rect.width, rect.height);
      img.src = prev;
    }
  }

  function pos(e) {
    const rect = canvas.getBoundingClientRect();
    const p = e.touches ? e.touches[0] : e;
    return { x: p.clientX - rect.left, y: p.clientY - rect.top };
  }

  function start(e) {
    e.preventDefault();
    drawing = true;
    dirty = true;
    last = pos(e);
  }

  function move(e) {
    if (!drawing) return;
    e.preventDefault();
    const p = pos(e);
    ctx.beginPath();
    ctx.moveTo(last.x, last.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    last = p;
  }

  function end() { drawing = false; }

  // Pointer Events cubren mouse + touch + lápiz de forma unificada
  canvas.addEventListener('pointerdown', start);
  canvas.addEventListener('pointermove', move);
  window.addEventListener('pointerup', end);

  // Evitar el scroll de la página al firmar en mobile
  canvas.style.touchAction = 'none';

  // Redimensionar cuando el canvas se hace visible (modal) o cambia el tamaño
  window.addEventListener('resize', resize);
  setTimeout(resize, 0);

  return {
    resize,
    isEmpty() { return !dirty; },
    clear() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      dirty = false;
    },
    toDataURL() {
      // Aplanar sobre fondo blanco (el canvas es transparente)
      const out = document.createElement('canvas');
      out.width = canvas.width;
      out.height = canvas.height;
      const octx = out.getContext('2d');
      octx.fillStyle = '#ffffff';
      octx.fillRect(0, 0, out.width, out.height);
      octx.drawImage(canvas, 0, 0);
      return out.toDataURL('image/png');
    },
  };
}
