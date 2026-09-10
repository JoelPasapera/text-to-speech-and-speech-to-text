import { EventBus } from '../core/event-bus.js';
import { chunkForSpeech } from './text-chunker.js';

/**
 * Envoltura sobre speechSynthesis.
 *
 * Igual que con el reconocedor, la API nativa no se puede usar en crudo:
 *
 *  1. Chrome deja de hablar tras unos quince segundos si nadie toca la cola.
 *     El remedio conocido es un latido `pause()` + `resume()` periódico. Sólo
 *     se activa mientras hay habla en curso y se apaga al terminar, porque en
 *     otros motores ese mismo latido introduce cortes.
 *
 *  2. Los enunciados largos se truncan sin avisar. Por eso se trocea antes y
 *     se encola fragmento a fragmento (ver text-chunker.js).
 *
 *  3. La cola nativa es global y sobrevive a recargas parciales. Se llama a
 *     `cancel()` antes de cada intervención nueva para no acumular restos.
 *
 *  4. En iOS el primer `speak()` debe salir de un gesto del usuario. No hay
 *     forma de evitarlo desde aquí; sí se puede evitar el fallo silencioso
 *     informando de que nunca llegó `start`.
 *
 * Eventos: 'start', 'chunk', 'end', 'error'.
 */

const KEEPALIVE_INTERVAL_MS = 10_000;
const START_TIMEOUT_MS = 1500;

export class Synthesizer {
  /**
   * @param {object} [options]
   * @param {number} [options.rate] 0.1 a 10, 1 es normal.
   * @param {number} [options.pitch] 0 a 2, 1 es normal.
   * @param {number} [options.volume] 0 a 1.
   */
  constructor({ rate = 1, pitch = 1, volume = 1 } = {}) {
    if (!('speechSynthesis' in globalThis)) {
      throw new Error('Synthesizer: este navegador no soporta síntesis de voz.');
    }

    this.events = new EventBus();
    this.rate = rate;
    this.pitch = pitch;
    this.volume = volume;
    /** @type {SpeechSynthesisVoice|null} */
    this.voice = null;

    this.speaking = false;
    /** @type {string[]} */
    this.queue = [];
    this.queueIndex = 0;
    this.keepaliveTimer = 0;
    this.startTimer = 0;
    /** Token de generación: invalida callbacks de intervenciones canceladas. */
    this.generation = 0;
    /**
     * Flujo abierto: hay más texto en camino aunque la cola esté vacía ahora
     * mismo. Sin esta bandera, el sintetizador daría por terminada la lectura
     * cada vez que se adelanta al generador que lo alimenta.
     */
    this.streamOpen = false;
  }

  on(type, handler) {
    return this.events.on(type, handler);
  }

  /** @param {SpeechSynthesisVoice|null} voice */
  setVoice(voice) {
    this.voice = voice;
  }

  /** @param {{rate?: number, pitch?: number, volume?: number}} params */
  setParams({ rate, pitch, volume }) {
    if (rate !== undefined) this.rate = rate;
    if (pitch !== undefined) this.pitch = pitch;
    if (volume !== undefined) this.volume = volume;
  }

  /**
   * Lee el texto en voz alta. Cancela cualquier intervención anterior.
   * @param {string} text
   * @returns {boolean} false si no había nada que decir.
   */
  speak(text) {
    const trimmed = text.trim();
    if (!trimmed) return false;

    this.cancel();

    this.queue = chunkForSpeech(trimmed);
    this.queueIndex = 0;
    if (this.queue.length === 0) return false;

    const generation = ++this.generation;
    this.speaking = true;
    this.events.emit('start', { chunks: this.queue.length, text: trimmed });

    // Si `start` no llega a tiempo, casi siempre es la restricción de gesto de
    // usuario en iOS. Mejor decirlo que quedarse en silencio.
    this.startTimer = setTimeout(() => {
      if (this.generation === generation && this.speaking && this.queueIndex === 0) {
        this.events.emit('error', {
          code: 'no-start',
          message: 'La síntesis no arrancó. En iOS debe iniciarse desde un toque directo.',
        });
      }
    }, START_TIMEOUT_MS);

    this.#startKeepalive();
    this.#speakNext(generation);
    return true;
  }

  /**
   * Abre una lectura incremental. Pensada para texto que se produce a trozos
   * (la respuesta de un modelo, por ejemplo): en vez de esperar al final para
   * hablar, se van encolando oraciones conforme se completan.
   *
   * Cancela lo que hubiera sonando, igual que speak().
   */
  beginStream() {
    this.cancel();

    this.queue = [];
    this.queueIndex = 0;
    this.streamOpen = true;
    this.speaking = true;

    const generation = ++this.generation;
    this.events.emit('start', { chunks: 0, text: '', streaming: true });
    this.#startKeepalive();
    return generation;
  }

  /**
   * Añade texto a la lectura en curso sin interrumpirla.
   * @param {string} text Normalmente una oración completa.
   * @returns {boolean} false si el flujo no estaba abierto o no había texto.
   */
  enqueue(text) {
    if (!this.streamOpen) return false;

    const trimmed = text.trim();
    if (!trimmed) return false;

    const pieces = chunkForSpeech(trimmed);
    if (pieces.length === 0) return false;

    const wasDrained = this.queueIndex >= this.queue.length;
    for (const piece of pieces) this.queue.push(piece);

    // Si el reproductor se había quedado sin material, hay que reanimarlo:
    // nadie va a llamar a #speakNext por él.
    if (wasDrained) this.#speakNext(this.generation);
    return true;
  }

  /**
   * Declara que no llegará más texto. La lectura termina cuando se agote lo
   * que ya está encolado, no en este instante.
   */
  endStream() {
    if (!this.streamOpen) return;
    this.streamOpen = false;

    // Si la cola ya estaba seca, este es el momento de cerrar de verdad.
    if (this.queueIndex >= this.queue.length) this.#speakNext(this.generation);
  }

  /** Detiene el habla y vacía la cola. */
  cancel() {
    this.generation++;
    this.#stopKeepalive();
    this.#clearStartTimer();

    this.queue = [];
    this.queueIndex = 0;
    this.streamOpen = false;

    try {
      speechSynthesis.cancel();
    } catch {
      /* nada que cancelar */
    }

    if (this.speaking) {
      this.speaking = false;
      this.events.emit('end', { cancelled: true });
    }
  }

  dispose() {
    this.cancel();
    this.events.clear();
  }

  // --- Interno -------------------------------------------------------------

  #speakNext(generation) {
    if (generation !== this.generation) return;

    if (this.queueIndex >= this.queue.length) {
      // Cola vacía pero el productor sigue vivo: no es el final, es una pausa.
      // Volverá a entrar aquí desde enqueue() o desde endStream().
      if (this.streamOpen) return;

      this.speaking = false;
      this.#stopKeepalive();
      this.#clearStartTimer();
      this.events.emit('end', { cancelled: false });
      return;
    }

    const index = this.queueIndex;
    const chunk = this.queue[index];
    const utterance = new SpeechSynthesisUtterance(chunk);

    utterance.rate = this.rate;
    utterance.pitch = this.pitch;
    utterance.volume = this.volume;
    if (this.voice) {
      utterance.voice = this.voice;
      // Algunos motores ignoran `voice` si `lang` no concuerda.
      utterance.lang = this.voice.lang;
    }

    utterance.onstart = () => {
      if (generation !== this.generation) return;
      this.#clearStartTimer();
      this.events.emit('chunk', { index, total: this.queue.length, text: chunk });
    };

    utterance.onend = () => {
      if (generation !== this.generation) return;
      this.queueIndex++;
      this.#speakNext(generation);
    };

    utterance.onerror = (event) => {
      if (generation !== this.generation) return;

      // `interrupted` y `canceled` son consecuencia de cancel(), no fallos.
      if (event.error === 'interrupted' || event.error === 'canceled') return;

      this.events.emit('error', {
        code: event.error,
        message: `No se pudo sintetizar el fragmento ${index + 1}: ${event.error}`,
      });

      // Un fragmento roto no debe tumbar la lectura completa.
      this.queueIndex++;
      this.#speakNext(generation);
    };

    speechSynthesis.speak(utterance);
  }

  #startKeepalive() {
    this.#stopKeepalive();
    this.keepaliveTimer = setInterval(() => {
      if (!speechSynthesis.speaking || speechSynthesis.paused) return;
      speechSynthesis.pause();
      speechSynthesis.resume();
    }, KEEPALIVE_INTERVAL_MS);
  }

  #stopKeepalive() {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = 0;
    }
  }

  #clearStartTimer() {
    if (this.startTimer) {
      clearTimeout(this.startTimer);
      this.startTimer = 0;
    }
  }
}
