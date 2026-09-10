import { EventBus } from '../core/event-bus.js';

/**
 * Modelo de la transcripción. Único dueño del texto acumulado.
 *
 * Existe separado del reconocedor porque las sesiones del motor se abren y
 * cierran constantemente y cada una reinicia sus índices: la continuidad del
 * documento es responsabilidad de aquí, no de la API del navegador.
 *
 * Eventos: 'change' (segmentos finales) y 'interim' (hipótesis en curso).
 */
export class TranscriptStore {
  constructor() {
    this.events = new EventBus();
    /** @type {{text: string, confidence: number|null, alternatives: string[], at: number}[]} */
    this.segments = [];
    this.interim = '';
  }

  on(type, handler) {
    return this.events.on(type, handler);
  }

  /** @param {{text: string, confidence: number|null, alternatives: string[], at: number}} segment */
  commit(segment) {
    this.segments.push(segment);
    this.interim = '';
    this.events.emit('change', this.segments);
    this.events.emit('interim', '');
  }

  /** @param {string} text */
  setInterim(text) {
    if (this.interim === text) return;
    this.interim = text;
    this.events.emit('interim', text);
  }

  /** Elimina el último segmento confirmado. */
  undo() {
    if (this.segments.length === 0) return false;
    this.segments.pop();
    this.events.emit('change', this.segments);
    return true;
  }

  clear() {
    if (this.segments.length === 0 && this.interim === '') return;
    this.segments.length = 0;
    this.interim = '';
    this.events.emit('change', this.segments);
    this.events.emit('interim', '');
  }

  get isEmpty() {
    return this.segments.length === 0 && this.interim === '';
  }

  /**
   * Texto plano listo para copiar o para enviar al sintetizador.
   * @param {boolean} [includeInterim]
   * @returns {string}
   */
  toText(includeInterim = false) {
    const parts = this.segments.map((s) => s.text);
    if (includeInterim && this.interim) parts.push(this.interim);
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  }

  get wordCount() {
    const text = this.toText();
    return text ? text.split(/\s+/).length : 0;
  }
}
