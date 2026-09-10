import { EventBus } from '../core/event-bus.js';
import { getRecognitionConstructor } from './capabilities.js';

/**
 * Envoltura sobre SpeechRecognition con una máquina de estados explícita.
 *
 * El motivo de que esto no sea "cuatro líneas alrededor de la API nativa":
 *
 *  1. `continuous = true` no es continuo. El motor cierra la sesión por su
 *     cuenta tras unos segundos de silencio y dispara `end`. Para dictado real
 *     hay que reabrirla, distinguiendo el cierre del motor del que pidió el
 *     usuario. De ahí `desired` frente a `state`.
 *
 *  2. Llamar a `start()` sobre una sesión que aún no terminó lanza
 *     InvalidStateError. El reinicio va siempre diferido, nunca dentro de `end`.
 *
 *  3. Cada sesión nueva reinicia `resultIndex`. Los segmentos finales por tanto
 *     no se pueden leer del índice absoluto: se emiten hacia arriba conforme
 *     llegan y quien acumula es el almacén, no esto.
 *
 *  4. Los errores no son equivalentes. `no-speech` y `aborted` son rutina;
 *     `network` merece reintento con espera creciente; `not-allowed` es
 *     definitivo y hay que dejar de insistir.
 *
 *  5. Mientras el sintetizador habla, el micrófono se oye a sí mismo. La
 *     compuerta `suspend`/`resume` implementa half-duplex: es la solución
 *     barata al eco. La cara sería un filtro adaptativo NLMS.
 *
 * Eventos: 'state', 'interim', 'final', 'error', 'notice'.
 */

/** Errores que no tiene sentido reintentar. */
const FATAL_ERRORS = new Set([
  'not-allowed',
  'service-not-allowed',
  'language-not-supported',
  'bad-grammar',
]);

/** Errores que forman parte de la operación normal y no se reportan al usuario. */
const BENIGN_ERRORS = new Set(['no-speech', 'aborted']);

const RESTART_DELAY_MS = 250;
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 8000;

export class Recognizer {
  /**
   * @param {object} [options]
   * @param {string} [options.lang] Etiqueta BCP 47.
   * @param {number} [options.maxAlternatives]
   * @param {boolean} [options.preferLocal] Pedir procesamiento en el dispositivo.
   */
  constructor({ lang = 'es-PE', maxAlternatives = 1, preferLocal = false } = {}) {
    const Ctor = getRecognitionConstructor();
    if (!Ctor) throw new Error('Recognizer: este navegador no soporta reconocimiento de voz.');

    this.events = new EventBus();
    this.Ctor = Ctor;
    this.lang = lang;
    this.maxAlternatives = maxAlternatives;
    this.preferLocal = preferLocal;

    /** Estado observado. @type {'idle'|'starting'|'listening'|'suspended'|'stopping'} */
    this.state = 'idle';
    /** Estado que el usuario pidió. La diferencia con `state` gobierna el reinicio. */
    this.desired = 'idle';

    /** @type {SpeechRecognition|null} */
    this.session = null;
    this.restartTimer = 0;
    this.backoffAttempts = 0;
    /** Marca de que la sesión se cerró por una suspensión, no por el motor. */
    this.suspendPending = false;
  }

  /** @param {string} type @param {Function} handler */
  on(type, handler) {
    return this.events.on(type, handler);
  }

  // --- Control público -----------------------------------------------------

  start() {
    if (this.desired === 'listening') return;
    this.desired = 'listening';
    this.backoffAttempts = 0;
    this.#openSession();
  }

  stop() {
    this.desired = 'idle';
    this.#cancelRestart();
    this.#setState('stopping');
    this.#closeSession();
  }

  /**
   * Cierra el micrófono sin olvidar que el usuario quería escuchar.
   * Se usa mientras habla el sintetizador.
   */
  suspend() {
    if (this.desired !== 'listening' || this.state === 'suspended') return;
    this.suspendPending = true;
    this.#cancelRestart();
    this.#setState('suspended');
    this.#closeSession();
  }

  /** Reabre el micrófono tras una suspensión. */
  resume() {
    if (this.desired !== 'listening' || this.state !== 'suspended') return;
    this.suspendPending = false;
    this.backoffAttempts = 0;
    this.#openSession();
  }

  /**
   * Cambia el idioma en caliente reabriendo la sesión si hacía falta.
   * @param {string} lang
   */
  setLanguage(lang) {
    if (lang === this.lang) return;
    this.lang = lang;

    if (this.desired === 'listening') {
      // Reabrir con el idioma nuevo: la sesión viva conserva el anterior.
      this.#closeSession();
      this.#scheduleRestart(RESTART_DELAY_MS);
    }
  }

  dispose() {
    this.desired = 'idle';
    this.#cancelRestart();
    this.#closeSession();
    this.events.clear();
  }

  // --- Ciclo de vida de la sesión ------------------------------------------

  #openSession() {
    this.#cancelRestart();

    // Si la sesión anterior todavía no ha disparado `end`, abrir ahora daría
    // InvalidStateError. Se difiere en vez de descartar la petición en
    // silencio, que dejaría el reconocedor colgado tras un resume() temprano.
    if (this.session) {
      this.#scheduleRestart(RESTART_DELAY_MS);
      return;
    }

    this.#setState('starting');

    const session = new this.Ctor();
    session.lang = this.lang;
    session.continuous = true;
    session.interimResults = true;
    session.maxAlternatives = this.maxAlternatives;

    // `processLocally` sólo existe en navegadores con modo en el dispositivo.
    // Asignarlo donde no existe es inocuo; pedirlo sin paquete de idioma
    // instalado produce un error 'language-not-supported' que degradamos abajo.
    if (this.preferLocal && 'processLocally' in session) {
      session.processLocally = true;
    }

    session.onstart = () => {
      this.backoffAttempts = 0;
      this.#setState('listening');
    };

    session.onresult = (event) => this.#handleResult(event);
    session.onerror = (event) => this.#handleError(event);
    session.onend = () => this.#handleEnd();

    this.session = session;

    try {
      session.start();
    } catch (err) {
      // InvalidStateError si quedaba una sesión anterior sin cerrar del todo.
      this.session = null;
      this.#scheduleRestart(RESTART_DELAY_MS);
    }
  }

  #closeSession() {
    const session = this.session;
    if (!session) {
      if (this.state === 'stopping') this.#setState('idle');
      return;
    }

    session.onresult = null;
    session.onerror = null;

    // `onend` sigue conectado a propósito: es quien decide si toca reabrir.
    try {
      session.abort();
    } catch {
      /* la sesión ya estaba muerta */
    }
  }

  #handleEnd() {
    this.session = null;

    if (this.desired !== 'listening') {
      this.#setState('idle');
      return;
    }
    if (this.suspendPending || this.state === 'suspended') {
      this.#setState('suspended');
      return;
    }

    // El motor cerró por su cuenta y el usuario sigue queriendo dictar.
    this.#scheduleRestart(RESTART_DELAY_MS);
  }

  #handleError(event) {
    const code = event.error;

    if (BENIGN_ERRORS.has(code)) return; // `onend` se encarga de reabrir.

    if (code === 'language-not-supported' && this.preferLocal) {
      // El paquete local no está instalado: bajamos al motor remoto en vez de
      // dejar al usuario sin dictado.
      this.preferLocal = false;
      this.events.emit('notice', {
        code: 'local-fallback',
        message: 'No hay paquete de idioma local. Se usará el motor en línea.',
      });
      return;
    }

    if (FATAL_ERRORS.has(code)) {
      this.desired = 'idle';
      this.#cancelRestart();
      this.events.emit('error', { code, fatal: true, message: describeError(code) });
      return;
    }

    // Transitorio: 'network', 'audio-capture'. Reintento con espera creciente.
    this.backoffAttempts++;
    const delay = Math.min(BACKOFF_BASE_MS * 2 ** (this.backoffAttempts - 1), BACKOFF_MAX_MS);
    this.events.emit('error', { code, fatal: false, message: describeError(code), retryInMs: delay });
    this.#scheduleRestart(delay);
  }

  #handleResult(event) {
    // Sólo interesan los resultados nuevos: los anteriores ya se emitieron.
    let interim = '';

    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      const best = result[0];

      if (result.isFinal) {
        const text = best.transcript.trim();
        if (!text) continue;

        const alternatives = [];
        for (let a = 1; a < result.length; a++) alternatives.push(result[a].transcript.trim());

        this.events.emit('final', {
          text,
          confidence: Number.isFinite(best.confidence) ? best.confidence : null,
          alternatives,
          at: Date.now(),
        });
      } else {
        interim += best.transcript;
      }
    }

    // Siempre se emite, incluso vacío: así la vista limpia el parcial anterior.
    this.events.emit('interim', { text: interim.trim() });
  }

  // --- Interno -------------------------------------------------------------

  #scheduleRestart(delay) {
    this.#cancelRestart();
    this.restartTimer = setTimeout(() => {
      this.restartTimer = 0;
      if (this.desired === 'listening' && !this.suspendPending) this.#openSession();
    }, delay);
  }

  #cancelRestart() {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = 0;
    }
  }

  #setState(next) {
    if (this.state === next) return;
    this.state = next;
    this.events.emit('state', { state: next, desired: this.desired });
  }
}

/**
 * Mensajes accionables. El usuario necesita saber qué hacer, no el código.
 * @param {string} code
 * @returns {string}
 */
function describeError(code) {
  switch (code) {
    case 'not-allowed':
      return 'Falta permiso de micrófono. Habilítalo en los ajustes del sitio y vuelve a empezar.';
    case 'service-not-allowed':
      return 'El navegador bloqueó el servicio de reconocimiento.';
    case 'language-not-supported':
      return 'El motor no reconoce este idioma. Prueba con otra variante del español.';
    case 'audio-capture':
      return 'No se detecta micrófono. Conecta uno y vuelve a empezar.';
    case 'network':
      return 'Sin conexión con el motor de reconocimiento. Reintentando.';
    default:
      return `Fallo del reconocimiento (${code}).`;
  }
}
