import { EventBus } from '../core/event-bus.js';

/**
 * Envoltura sobre la Prompt API integrada en Chrome (Gemini Nano).
 *
 * Lo que aporta sobre llamar a `LanguageModel` directamente:
 *
 *  1. Detección honesta. La API existe o no, y aunque exista puede que el
 *     modelo no esté disponible en ese equipo. Se traduce a un motivo legible
 *     en vez de dejar que la aplicación reviente.
 *
 *  2. Normalización del flujo. `promptStreaming()` ha entregado en distintas
 *     versiones de Chrome tanto deltas como texto acumulado. Aquí se detecta
 *     cuál es y siempre se emiten deltas hacia arriba.
 *
 *  3. Contexto. La ventana se llena y hay que enterarse antes de que reviente
 *     con QuotaExceededError, no después.
 *
 * Restricciones de la plataforma que condicionan el diseño:
 *  - La descarga del modelo exige activación del usuario, así que `open()` se
 *    tiene que llamar desde un manejador de clic.
 *  - La API no está disponible en Web Workers, de modo que la inferencia va en
 *    el hilo principal. De ahí que todo el consumo sea en streaming: es lo
 *    único que evita que la interfaz se congele.
 *
 * Eventos: 'download', 'state', 'error', 'contextoverflow'.
 */

/** Idiomas que acepta la Prompt API. El resto produce NotSupportedError. */
const SUPPORTED_LANGUAGES = new Set(['en', 'ja', 'es', 'de', 'fr']);

export class LanguageModelBridge {
  /**
   * @param {object} [options]
   * @param {string} [options.language] Código de dos letras.
   * @param {string} [options.systemPrompt]
   */
  constructor({ language = 'es', systemPrompt = '' } = {}) {
    this.events = new EventBus();
    this.language = SUPPORTED_LANGUAGES.has(language) ? language : 'es';
    this.systemPrompt = systemPrompt;

    /** @type {any} */
    this.session = null;
    this.status = 'unknown';
    /** Token de generación: invalida el consumo de respuestas abandonadas. */
    this.generation = 0;
  }

  on(type, handler) {
    return this.events.on(type, handler);
  }

  /** Opciones que deben ser idénticas en availability() y en create(). */
  get #options() {
    return {
      expectedInputs: [{ type: 'text', languages: [this.language] }],
      expectedOutputs: [{ type: 'text', languages: [this.language] }],
    };
  }

  /** @returns {boolean} Si el navegador expone siquiera la API. */
  static get supported() {
    return typeof globalThis.LanguageModel?.availability === 'function';
  }

  /**
   * Consulta el estado del modelo sin descargarlo.
   * @returns {Promise<'available'|'downloadable'|'downloading'|'unavailable'>}
   */
  async probe() {
    if (!LanguageModelBridge.supported) {
      this.status = 'unavailable';
      return 'unavailable';
    }

    try {
      const status = await globalThis.LanguageModel.availability(this.#options);
      this.status = status ?? 'unavailable';
    } catch {
      // NotSupportedError por idioma o modalidad no soportada, entre otros.
      this.status = 'unavailable';
    }

    this.events.emit('state', { status: this.status });
    return this.status;
  }

  /**
   * Crea la sesión, descargando el modelo si hace falta.
   * DEBE invocarse desde un manejador de gesto del usuario: sin activación,
   * Chrome no inicia la descarga.
   *
   * @returns {Promise<boolean>} true si la sesión quedó lista.
   */
  async open() {
    if (this.session) return true;
    if (!LanguageModelBridge.supported) return false;

    const initialPrompts = this.systemPrompt
      ? [{ role: 'system', content: this.systemPrompt }]
      : undefined;

    try {
      this.session = await globalThis.LanguageModel.create({
        ...this.#options,
        ...(initialPrompts ? { initialPrompts } : {}),
        monitor: (m) => {
          m.addEventListener('downloadprogress', (event) => {
            this.events.emit('download', { progress: event.loaded });
          });
        },
      });
    } catch (err) {
      this.session = null;
      this.events.emit('error', {
        code: err?.name ?? 'create-failed',
        message: describeCreateError(err),
      });
      return false;
    }

    this.session.addEventListener?.('contextoverflow', () => {
      this.events.emit('contextoverflow', this.usage);
    });

    this.status = 'available';
    this.events.emit('state', { status: 'available' });
    return true;
  }

  /** @returns {{used: number, total: number}|null} */
  get usage() {
    if (!this.session) return null;
    return {
      used: this.session.contextUsage ?? 0,
      total: this.session.contextWindow ?? 0,
    };
  }

  /**
   * Envía un mensaje y devuelve los fragmentos de la respuesta conforme llegan.
   *
   * @param {string} text
   * @param {AbortSignal} [signal]
   * @returns {AsyncGenerator<string>} Deltas de texto, nunca acumulados.
   */
  async *ask(text, signal) {
    if (!this.session) throw new Error('LanguageModelBridge: no hay sesión abierta.');

    const generation = ++this.generation;
    let stream;

    try {
      stream = this.session.promptStreaming(text, signal ? { signal } : undefined);
    } catch (err) {
      this.events.emit('error', { code: err?.name ?? 'prompt-failed', message: describePromptError(err) });
      return;
    }

    // Chrome ha entregado el flujo de dos formas según la versión: deltas
    // sueltos o el texto completo reenviado en cada trozo. Se detecta por
    // contenido en vez de por versión del navegador, que sería más frágil.
    let emitted = '';

    try {
      for await (const chunk of stream) {
        if (generation !== this.generation) return;
        if (typeof chunk !== 'string' || chunk === '') continue;

        let delta;
        if (emitted !== '' && chunk.startsWith(emitted)) {
          delta = chunk.slice(emitted.length);
          emitted = chunk;
        } else {
          delta = chunk;
          emitted += chunk;
        }

        if (delta) yield delta;
      }
    } catch (err) {
      if (err?.name === 'AbortError') return;
      this.events.emit('error', { code: err?.name ?? 'stream-failed', message: describePromptError(err) });
    }
  }

  /** Invalida cualquier respuesta que se esté consumiendo ahora mismo. */
  abort() {
    this.generation++;
  }

  close() {
    this.abort();
    try {
      this.session?.destroy();
    } catch {
      /* la sesión ya estaba destruida */
    }
    this.session = null;
  }

  dispose() {
    this.close();
    this.events.clear();
  }
}

/**
 * Motivo por el que el modelo no está disponible, en términos accionables.
 * @param {string} status
 * @returns {string}
 */
export function describeAvailability(status) {
  switch (status) {
    case 'available':
      return 'El modelo está listo en este equipo.';
    case 'downloadable':
      return 'Hay que descargar el modelo la primera vez. Son varios gigas.';
    case 'downloading':
      return 'El modelo se está descargando.';
    default:
      return LanguageModelBridge.supported
        ? 'Este equipo no cumple los requisitos del modelo: hacen falta 22 GB libres y una GPU con más de 4 GB de VRAM, o 16 GB de RAM y cuatro núcleos.'
        : 'Este navegador no incluye modelo de lenguaje. Hace falta Chrome 148 o posterior en Windows, macOS o Linux de escritorio.';
  }
}

function describeCreateError(err) {
  if (err?.name === 'NotSupportedError') {
    return 'El modelo no admite el idioma solicitado.';
  }
  if (err?.name === 'NotAllowedError') {
    return 'La descarga del modelo debe iniciarse desde una acción tuya. Vuelve a pulsar el botón.';
  }
  return 'No se pudo abrir el modelo de lenguaje.';
}

function describePromptError(err) {
  if (err?.name === 'QuotaExceededError') {
    const pedido = err.requested ?? '?';
    const ventana = err.contextWindow ?? '?';
    return `El mensaje no cabe en el contexto (${pedido} de ${ventana}). Empieza una conversación nueva.`;
  }
  if (err?.name === 'InvalidStateError') {
    return 'La sesión del modelo se cerró. Empieza una conversación nueva.';
  }
  return 'El modelo falló al generar la respuesta.';
}
