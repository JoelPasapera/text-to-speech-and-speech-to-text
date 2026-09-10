import { EventBus } from '../core/event-bus.js';
import { SentenceStreamer } from './sentence-streamer.js';

/**
 * Orquesta el ciclo de conversación: escuchar, decidir que el usuario terminó,
 * generar y leer la respuesta.
 *
 * El problema difícil no es llamar al modelo, es **saber cuándo el usuario ha
 * terminado de hablar**. El reconocedor entrega resultados finales por trozos,
 * y un final no significa fin de turno: significa que el motor cerró un
 * segmento. Alguien que dice "necesito que me expliques" seguido de una pausa
 * de pensar y luego "cómo funciona esto" produce dos finales y un solo turno.
 *
 * La regla que se aplica aquí es endpointing por silencio: cualquier señal de
 * voz (parcial o final) reinicia un temporizador, y el turno se cierra cuando
 * ese temporizador expira sin actividad nueva. Es la misma heurística que usan
 * los asistentes comerciales y funciona bien con el patrón de pausas del habla
 * natural en español.
 *
 * El resto de decisiones de diseño:
 *
 *  - El historial lo mantiene la sesión del modelo, no esto. Aquí sólo se
 *    guarda una copia para pintar el diálogo en pantalla.
 *  - La respuesta se lee por oraciones conforme se generan, no al final. Sin
 *    eso, el usuario aguanta el tiempo completo de generación en silencio.
 *  - Mientras se genera o se lee, el turno del usuario está cerrado. Los
 *    resultados que llegasen (eco del micrófono, ruido) se descartan.
 *
 * Eventos: 'state', 'turn', 'delta', 'say', 'error'.
 */

const SILENCE_MS = 1100;
const MIN_TURN_CHARS = 2;

export class Conversation {
  /**
   * @param {import('./language-model.js').LanguageModelBridge} model
   * @param {object} [options]
   * @param {number} [options.silenceMs] Pausa que cierra el turno.
   * @param {number} [options.minSentenceChars] Mínimo antes de mandar a hablar.
   */
  constructor(model, { silenceMs = SILENCE_MS, minSentenceChars = 24 } = {}) {
    this.events = new EventBus();
    this.model = model;
    this.silenceMs = silenceMs;
    this.streamer = new SentenceStreamer({ minLength: minSentenceChars });

    /** @type {'idle'|'listening'|'thinking'|'speaking'} */
    this.state = 'idle';
    /** @type {{role: 'user'|'assistant', text: string}[]} */
    this.history = [];

    this.turnBuffer = [];
    this.silenceTimer = 0;
    /** @type {AbortController|null} */
    this.controller = null;
    this.active = false;
  }

  on(type, handler) {
    return this.events.on(type, handler);
  }

  // --- Control -------------------------------------------------------------

  start() {
    this.active = true;
    this.#reset();
    this.#setState('listening');
  }

  stop() {
    this.active = false;
    this.#cancelTimer();
    this.abort();
    this.#reset();
    this.#setState('idle');
  }

  /** Interrumpe la generación en curso sin salir del modo conversación. */
  abort() {
    this.controller?.abort();
    this.controller = null;
    this.model.abort();
    this.streamer.reset();
  }

  /** Vacía el historial y abre una sesión limpia. */
  clearHistory() {
    this.abort();
    this.history.length = 0;
    this.events.emit('turn', { reset: true });
  }

  // --- Entrada desde el reconocedor ---------------------------------------

  /**
   * Hipótesis en curso: no aporta texto al turno, sólo indica que el usuario
   * sigue hablando y por tanto retrasa el cierre.
   * @param {string} text
   */
  noteInterim(text) {
    if (!this.active || this.state !== 'listening') return;
    if (!text.trim()) return;
    this.#armTimer();
  }

  /**
   * Segmento confirmado. Se acumula: puede haber varios en un mismo turno.
   * @param {string} text
   */
  addFinal(text) {
    if (!this.active || this.state !== 'listening') return;

    const trimmed = text.trim();
    if (!trimmed) return;

    this.turnBuffer.push(trimmed);
    this.#armTimer();
  }

  /** Cierra el turno ahora, sin esperar al silencio. */
  commitNow() {
    this.#cancelTimer();
    void this.#closeTurn();
  }

  /** El sintetizador terminó de leer: el micrófono vuelve a ser del usuario. */
  noteSpeechFinished() {
    if (!this.active) return;
    this.#reset();
    this.#setState('listening');
  }

  // --- Ciclo del turno -----------------------------------------------------

  #armTimer() {
    this.#cancelTimer();
    this.silenceTimer = setTimeout(() => {
      this.silenceTimer = 0;
      void this.#closeTurn();
    }, this.silenceMs);
  }

  #cancelTimer() {
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = 0;
    }
  }

  async #closeTurn() {
    if (!this.active || this.state !== 'listening') return;

    const text = this.turnBuffer.join(' ').replace(/\s+/g, ' ').trim();
    this.turnBuffer.length = 0;

    // Un carraspeo o una palabra suelta mal reconocida no merecen un turno.
    if (text.length < MIN_TURN_CHARS) return;

    this.history.push({ role: 'user', text });
    this.events.emit('turn', { role: 'user', text });

    this.#setState('thinking');
    await this.#generate(text);
  }

  async #generate(prompt) {
    this.controller = new AbortController();
    const { signal } = this.controller;

    this.streamer.reset();
    let full = '';
    let spoke = false;

    try {
      for await (const delta of this.model.ask(prompt, signal)) {
        if (signal.aborted) return;

        full += delta;
        this.events.emit('delta', { text: full });

        for (const sentence of this.streamer.push(delta)) {
          if (!spoke) {
            spoke = true;
            this.#setState('speaking');
          }
          this.events.emit('say', { text: sentence });
        }
      }

      if (signal.aborted) return;

      for (const sentence of this.streamer.flush()) {
        if (!spoke) {
          spoke = true;
          this.#setState('speaking');
        }
        this.events.emit('say', { text: sentence });
      }
    } catch (err) {
      if (err?.name !== 'AbortError') {
        this.events.emit('error', { message: 'El modelo no pudo responder.' });
      }
      this.#reset();
      this.#setState('listening');
      return;
    } finally {
      this.controller = null;
    }

    const answer = full.trim();
    if (answer) {
      this.history.push({ role: 'assistant', text: answer });
      this.events.emit('turn', { role: 'assistant', text: answer });
    }

    // Nada que leer: no habrá evento de fin de habla que devuelva el turno.
    if (!spoke) {
      this.#reset();
      this.#setState('listening');
    } else {
      this.events.emit('say', { text: '', done: true });
    }
  }

  #reset() {
    this.turnBuffer.length = 0;
    this.streamer.reset();
    this.#cancelTimer();
  }

  #setState(next) {
    if (this.state === next) return;
    this.state = next;
    this.events.emit('state', { state: next });
  }

  dispose() {
    this.stop();
    this.events.clear();
  }
}

/**
 * Instrucción de sistema.
 *
 * Está escrita para voz, no para pantalla, que es una diferencia enorme: las
 * listas, los títulos y el markdown que quedan bien leídos con los ojos suenan
 * fatal leídos en alto, y una respuesta de cinco párrafos que en pantalla se
 * ojea en dos segundos son cuarenta segundos de monólogo que nadie aguanta.
 */
export const SYSTEM_PROMPT = [
  'Eres un asistente de voz que conversa en español.',
  'Tus respuestas se van a leer en voz alta, así que escribe como se habla.',
  'Responde en dos o tres frases como máximo, salvo que te pidan explícitamente más detalle.',
  'No uses markdown, ni viñetas, ni títulos, ni emojis, ni tablas: sólo frases corrientes.',
  'Escribe los números y las abreviaturas tal como se pronuncian.',
  'Si no entiendes lo que te han dicho, pregunta en una frase corta en lugar de inventar.',
].join(' ');
