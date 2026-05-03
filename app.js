(() => {
  'use strict';

  // ────────────────────────────────────────────────────────────────────────────
  //  Web Worker (inline vía Blob URL) — decodifica en OffscreenCanvas y
  //  encodea con convertToBlob fuera del hilo principal.
  // ────────────────────────────────────────────────────────────────────────────
  const WORKER_SOURCE = `
    self.onmessage = async (e) => {
      const { id, file, format, quality, background } = e.data;
      try {
        const bitmap = await createImageBitmap(file);
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const ctx = canvas.getContext('2d');
        if (background) {
          ctx.fillStyle = background;
          ctx.fillRect(0, 0, canvas.width, canvas.height);
        }
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close && bitmap.close();
        const opts = { type: format };
        if (quality != null) opts.quality = quality;
        const blob = await canvas.convertToBlob(opts);
        if (!blob) throw new Error('Encoder devolvió blob vacío');
        if (blob.type !== format) {
          throw new Error('Formato no soportado por el navegador: ' + format);
        }
        self.postMessage({
          id, ok: true, blob,
          width: canvas.width, height: canvas.height
        });
      } catch (err) {
        self.postMessage({ id, ok: false, error: String(err && err.message || err) });
      }
    };
  `;

  // ────────────────────────────────────────────────────────────────────────────
  //  Estado global
  // ────────────────────────────────────────────────────────────────────────────
  const state = {
    files: new Map(),       // id → { id, file, status, blob?, newName?, element, thumbUrl }
    nextId: 1,
    worker: null,
    workerReady: false,
    pending: new Map(),     // id → { resolve, reject }
    converting: false,
  };

  // ────────────────────────────────────────────────────────────────────────────
  //  Refs DOM
  // ────────────────────────────────────────────────────────────────────────────
  const $ = (sel) => document.querySelector(sel);
  const dropzone     = $('#dropzone');
  const fileInput    = $('#file-input');
  const browseBtn    = $('#browse');
  const formatSelect = $('#format');
  const qualityInput = $('#quality');
  const qualityValue = $('#quality-value');
  const convertBtn   = $('#convert');
  const saveAllBtn   = $('#save-all');
  const clearBtn     = $('#clear');
  const fileListEl   = $('#file-list');
  const actionsEl    = $('#actions');
  const warningEl    = $('#warning');
  const itemTemplate = $('#file-item-template');

  // ────────────────────────────────────────────────────────────────────────────
  //  Worker setup (con fallback a hilo principal)
  // ────────────────────────────────────────────────────────────────────────────
  function initWorker() {
    if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') {
      return;
    }
    try {
      const blob = new Blob([WORKER_SOURCE], { type: 'application/javascript' });
      state.worker = new Worker(URL.createObjectURL(blob));
      state.worker.onmessage = (e) => {
        const { id } = e.data;
        const pending = state.pending.get(id);
        if (!pending) return;
        state.pending.delete(id);
        e.data.ok ? pending.resolve(e.data) : pending.reject(new Error(e.data.error));
      };
      state.worker.onerror = (e) => {
        console.error('Worker error:', e);
      };
      state.workerReady = true;
    } catch (err) {
      console.warn('Worker no disponible, usando hilo principal:', err);
    }
  }

  function convertViaWorker(file, format, quality, background) {
    return new Promise((resolve, reject) => {
      const id = state.nextId++;
      state.pending.set(id, { resolve, reject });
      state.worker.postMessage({ id, file, format, quality, background });
    });
  }

  // Fallback: convierte usando un canvas en el hilo principal.
  async function convertInMainThread(file, format, quality, background) {
    let source;
    try {
      source = await createImageBitmap(file);
    } catch {
      // Para SVG / formatos que createImageBitmap no maneja: usar Image element.
      source = await loadViaImageElement(file);
    }
    const canvas = document.createElement('canvas');
    canvas.width = source.width || source.naturalWidth;
    canvas.height = source.height || source.naturalHeight;
    const ctx = canvas.getContext('2d');
    if (background) {
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.drawImage(source, 0, 0);
    if (source.close) source.close();

    const blob = await new Promise((resolve, reject) => {
      const args = quality != null ? [format, quality] : [format];
      canvas.toBlob(
        (b) => b ? resolve(b) : reject(new Error('toBlob devolvió null')),
        ...args
      );
    });
    if (blob.type !== format) {
      throw new Error('Formato no soportado por el navegador: ' + format);
    }
    return { blob, width: canvas.width, height: canvas.height };
  }

  function loadViaImageElement(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('No se pudo decodificar la imagen')); };
      img.src = url;
    });
  }

  async function convertImage(file, format, quality, background) {
    if (state.workerReady) {
      try {
        return await convertViaWorker(file, format, quality, background);
      } catch (err) {
        // Si el worker falla (p.ej. SVG), reintenta en el hilo principal.
        return await convertInMainThread(file, format, quality, background);
      }
    }
    return await convertInMainThread(file, format, quality, background);
  }

  // Formatos sin canal alfa: necesitan fondo si la imagen original es transparente.
  const OPAQUE_FORMATS = new Set(['image/jpeg', 'image/bmp']);
  // Formatos con compresión con pérdida: aceptan parámetro quality.
  const LOSSY_FORMATS  = new Set(['image/jpeg', 'image/webp', 'image/avif', 'image/jxl']);

  function extForFormat(format) {
    switch (format) {
      case 'image/jpeg':   return '.jpg';
      case 'image/png':    return '.png';
      case 'image/webp':   return '.webp';
      case 'image/avif':   return '.avif';
      case 'image/bmp':    return '.bmp';
      case 'image/gif':    return '.gif';
      case 'image/x-icon': return '.ico';
      case 'image/tiff':   return '.tiff';
      case 'image/jxl':    return '.jxl';
      default:             return '.' + format.split('/')[1];
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  //  Detección de soporte de formato (para avisar si AVIF no se puede encodear)
  // ────────────────────────────────────────────────────────────────────────────
  // Formatos que el estándar Canvas garantiza en cualquier navegador moderno.
  // Evitamos probar (y devolver falsos negativos) sobre encoders que sabemos que existen.
  const GUARANTEED_FORMATS = new Set(['image/png', 'image/jpeg', 'image/webp']);

  async function canEncodeFormat(format) {
    if (GUARANTEED_FORMATS.has(format)) return true;
    // Dibuja un pixel real: algunos encoders fallan con canvas totalmente vacío.
    const draw = (ctx, w, h) => {
      ctx.fillStyle = '#ff0000';
      ctx.fillRect(0, 0, w, h);
    };
    // Estrategia 1: OffscreenCanvas (preferida).
    try {
      if (typeof OffscreenCanvas !== 'undefined') {
        const c = new OffscreenCanvas(4, 4);
        draw(c.getContext('2d'), 4, 4);
        const b = await c.convertToBlob({ type: format });
        if (b && b.type === format) return true;
      }
    } catch (e) {
      console.warn('[probe OffscreenCanvas]', format, e.message || e);
    }
    // Estrategia 2: canvas DOM tradicional.
    try {
      const c = document.createElement('canvas');
      c.width = c.height = 4;
      draw(c.getContext('2d'), 4, 4);
      const b = await new Promise((res) => c.toBlob(res, format));
      return !!(b && b.type === format);
    } catch (e) {
      console.warn('[probe canvas]', format, e.message || e);
      return false;
    }
  }

  // Marca con (no soportado) cada opción cuyo encoder no esté disponible.
  async function probeAllFormats() {
    const opts = [...formatSelect.options];
    const results = await Promise.all(opts.map((o) => canEncodeFormat(o.value)));
    const summary = {};
    opts.forEach((opt, i) => {
      const supported = results[i];
      summary[opt.value] = supported;
      opt.dataset.supported = supported ? '1' : '0';
      const baseLabel = opt.textContent.replace(/\s*·\s*no soportado$/i, '');
      opt.textContent = supported ? baseLabel : `${baseLabel} · no soportado`;
      opt.disabled = !supported;
    });
    console.info('[Soporte de encoders]', summary);
    // Si el seleccionado no es soportado, salta al primero que sí lo sea.
    if (formatSelect.selectedOptions[0] && formatSelect.selectedOptions[0].disabled) {
      const fallback = opts.find((o) => !o.disabled);
      if (fallback) formatSelect.value = fallback.value;
    }
  }

  async function checkFormatSupport() {
    const format = formatSelect.value;
    const ok = await canEncodeFormat(format);
    if (!ok) {
      const name = format.split('/')[1].toUpperCase();
      warningEl.hidden = false;
      warningEl.textContent = `⚠ Tu navegador no puede encodear a ${name}. Elige otro formato.`;
    } else {
      warningEl.hidden = true;
      warningEl.textContent = '';
    }
    // Mostrar/ocultar controles según el formato elegido.
    const qualityGroup = document.getElementById('quality-group');
    const bgGroup = document.getElementById('bg-group');
    qualityGroup.hidden = !LOSSY_FORMATS.has(format);
    bgGroup.hidden = !OPAQUE_FORMATS.has(format);
  }

  // ────────────────────────────────────────────────────────────────────────────
  //  Utilidades
  // ────────────────────────────────────────────────────────────────────────────
  function formatBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(2) + ' MB';
  }

  function newFileName(originalName, format) {
    const ext = extForFormat(format);
    const lastDot = originalName.lastIndexOf('.');
    const base = lastDot > 0 ? originalName.slice(0, lastDot) : originalName;
    return base + ext;
  }

  function isImageFile(file) {
    if (file.type && file.type.startsWith('image/')) return true;
    // Algunos sistemas no devuelven mime para HEIC/TIFF: fallback por extensión.
    return /\.(jpe?g|png|webp|avif|gif|bmp|ico|tiff?|svg|heic|heif)$/i.test(file.name);
  }

  // ────────────────────────────────────────────────────────────────────────────
  //  UI: gestión de la lista de archivos
  // ────────────────────────────────────────────────────────────────────────────
  function addFiles(fileList) {
    let added = 0;
    for (const file of fileList) {
      if (!isImageFile(file)) continue;
      const id = state.nextId++;
      const thumbUrl = URL.createObjectURL(file);
      const element = createFileItem({ id, file, thumbUrl });
      state.files.set(id, {
        id, file, element, thumbUrl,
        status: 'pending', blob: null, newName: null,
      });
      fileListEl.appendChild(element);
      added++;
    }
    if (added > 0) {
      fileListEl.hidden = false;
      actionsEl.hidden = false;
      updateSaveButton();
    }
  }

  function createFileItem({ id, file, thumbUrl }) {
    const node = itemTemplate.content.firstElementChild.cloneNode(true);
    node.dataset.id = String(id);
    node.querySelector('.file-thumb img').src = thumbUrl;
    node.querySelector('.file-name').textContent = file.name;
    node.querySelector('.file-size-original').textContent = formatBytes(file.size);
    node.querySelector('.file-remove').addEventListener('click', () => removeFile(id));
    node.querySelector('.file-download').addEventListener('click', () => downloadOne(id));
    return node;
  }

  function removeFile(id) {
    const item = state.files.get(id);
    if (!item) return;
    URL.revokeObjectURL(item.thumbUrl);
    item.element.remove();
    state.files.delete(id);
    if (state.files.size === 0) {
      fileListEl.hidden = true;
      actionsEl.hidden = true;
    }
    updateSaveButton();
  }

  function clearAll() {
    for (const item of state.files.values()) {
      URL.revokeObjectURL(item.thumbUrl);
    }
    state.files.clear();
    fileListEl.innerHTML = '';
    fileListEl.hidden = true;
    actionsEl.hidden = true;
    updateSaveButton();
  }

  function updateSaveButton() {
    const ready = [...state.files.values()].filter((it) => it.status === 'done');
    saveAllBtn.disabled = ready.length === 0;
    saveAllBtn.textContent = ready.length > 0
      ? `Guardar todo (${ready.length})`
      : 'Guardar todo';
  }

  function setItemState(id, status, opts = {}) {
    const item = state.files.get(id);
    if (!item) return;
    item.status = status;
    const el = item.element;
    el.classList.toggle('is-done', status === 'done');
    el.classList.toggle('is-error', status === 'error');

    const statusEl = el.querySelector('.file-status');
    const progressBar = el.querySelector('.file-progress-bar');

    if (status === 'processing') {
      statusEl.textContent = 'Convirtiendo…';
      progressBar.style.width = '40%';
    } else if (status === 'done') {
      statusEl.textContent = 'Listo';
      progressBar.style.width = '100%';
      el.querySelector('.file-arrow').hidden = false;
      el.querySelector('.file-size-new').textContent = formatBytes(opts.newSize);
      const savings = ((1 - opts.newSize / item.file.size) * 100);
      const savingsEl = el.querySelector('.file-savings');
      savingsEl.textContent = (savings >= 0 ? '−' : '+') + Math.abs(savings).toFixed(0) + '%';
      savingsEl.classList.toggle('is-negative', savings < 0);
      el.querySelector('.file-download').hidden = false;
    } else if (status === 'error') {
      statusEl.textContent = 'Error: ' + (opts.error || 'desconocido');
      progressBar.style.width = '100%';
    } else if (status === 'pending') {
      statusEl.textContent = 'Esperando…';
      progressBar.style.width = '0%';
      el.querySelector('.file-arrow').hidden = true;
      el.querySelector('.file-size-new').textContent = '';
      el.querySelector('.file-savings').textContent = '';
      el.querySelector('.file-download').hidden = true;
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  //  Conversión
  // ────────────────────────────────────────────────────────────────────────────
  async function convertAll() {
    if (state.converting) return;
    state.converting = true;
    convertBtn.disabled = true;
    clearBtn.disabled = true;
    saveAllBtn.disabled = true;

    const format = formatSelect.value;
    const quality = LOSSY_FORMATS.has(format) ? parseFloat(qualityInput.value) : null;
    const background = OPAQUE_FORMATS.has(format) ? document.getElementById('bg-color').value : null;

    // Resetea los items que ya estaban convertidos por si cambió formato/calidad.
    for (const item of state.files.values()) {
      if (item.blob) {
        item.blob = null;
        item.newName = null;
      }
      setItemState(item.id, 'pending');
    }

    const items = [...state.files.values()];
    for (const item of items) {
      setItemState(item.id, 'processing');
      try {
        const result = await convertImage(item.file, format, quality, background);
        item.blob = result.blob;
        item.newName = newFileName(item.file.name, format);
        setItemState(item.id, 'done', { newSize: result.blob.size });
      } catch (err) {
        setItemState(item.id, 'error', { error: err.message || String(err) });
      }
      updateSaveButton();
    }

    convertBtn.disabled = false;
    clearBtn.disabled = false;
    state.converting = false;
  }

  // ────────────────────────────────────────────────────────────────────────────
  //  Guardado
  // ────────────────────────────────────────────────────────────────────────────
  async function saveAll() {
    const ready = [...state.files.values()].filter((it) => it.status === 'done' && it.blob);
    if (ready.length === 0) return;

    if ('showDirectoryPicker' in window) {
      try {
        const dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
        saveAllBtn.disabled = true;
        for (const item of ready) {
          try {
            const fileHandle = await dirHandle.getFileHandle(
              await uniqueName(dirHandle, item.newName),
              { create: true }
            );
            const writable = await fileHandle.createWritable();
            await writable.write(item.blob);
            await writable.close();
            item.element.querySelector('.file-status').textContent = 'Guardado en carpeta';
          } catch (err) {
            item.element.querySelector('.file-status').textContent = 'Error guardando: ' + err.message;
          }
        }
      } catch (err) {
        if (err.name !== 'AbortError') {
          alert('No se pudo abrir la carpeta: ' + err.message);
        }
      } finally {
        updateSaveButton();
      }
    } else {
      // Fallback: descargas secuenciales con pequeño retardo entre cada una.
      saveAllBtn.disabled = true;
      for (const item of ready) {
        triggerDownload(item.blob, item.newName);
        await sleep(250);
      }
      updateSaveButton();
    }
  }

  // Evita colisiones de nombre dentro de la carpeta elegida.
  async function uniqueName(dirHandle, baseName) {
    const dot = baseName.lastIndexOf('.');
    const base = dot > 0 ? baseName.slice(0, dot) : baseName;
    const ext = dot > 0 ? baseName.slice(dot) : '';
    let candidate = baseName;
    let i = 1;
    while (true) {
      try {
        await dirHandle.getFileHandle(candidate, { create: false });
        candidate = `${base} (${i})${ext}`;
        i++;
      } catch {
        return candidate;
      }
    }
  }

  function downloadOne(id) {
    const item = state.files.get(id);
    if (!item || !item.blob) return;
    triggerDownload(item.blob, item.newName);
  }

  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  // ────────────────────────────────────────────────────────────────────────────
  //  Eventos
  // ────────────────────────────────────────────────────────────────────────────
  function bindEvents() {
    // Drag & drop
    ['dragenter', 'dragover'].forEach((ev) => {
      dropzone.addEventListener(ev, (e) => {
        e.preventDefault();
        dropzone.classList.add('is-dragging');
      });
    });
    ['dragleave', 'dragend', 'drop'].forEach((ev) => {
      dropzone.addEventListener(ev, (e) => {
        e.preventDefault();
        dropzone.classList.remove('is-dragging');
      });
    });
    dropzone.addEventListener('drop', (e) => {
      if (e.dataTransfer && e.dataTransfer.files) {
        addFiles(e.dataTransfer.files);
      }
    });

    // Bloquear drop fuera de la zona para evitar que el navegador abra la imagen.
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => e.preventDefault());

    // Click & teclado para abrir selector
    dropzone.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      fileInput.click();
    });
    dropzone.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        fileInput.click();
      }
    });
    browseBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      fileInput.click();
    });
    fileInput.addEventListener('change', (e) => {
      if (e.target.files) addFiles(e.target.files);
      fileInput.value = '';
    });

    // Controles
    qualityInput.addEventListener('input', () => {
      qualityValue.textContent = parseFloat(qualityInput.value).toFixed(2);
    });
    formatSelect.addEventListener('change', checkFormatSupport);

    // Acciones
    convertBtn.addEventListener('click', convertAll);
    saveAllBtn.addEventListener('click', saveAll);
    clearBtn.addEventListener('click', clearAll);
  }

  // ────────────────────────────────────────────────────────────────────────────
  //  Init
  // ────────────────────────────────────────────────────────────────────────────
  async function init() {
    initWorker();
    bindEvents();
    qualityValue.textContent = parseFloat(qualityInput.value).toFixed(2);
    await probeAllFormats();
    checkFormatSupport();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
