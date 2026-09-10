import { splitSentences } from '../tts/text-chunker.js';

/**
 * Convierte un goteo de fragmentos de texto en oraciones completas.
 *
 * El motivo es la latencia. Si se espera a que el modelo termine para empezar
 * a hablar, el usuario aguanta varios segundos de silencio. Emitiendo cada
 * oración en cuanto se cierra, la primera empieza a sonar mientras el modelo
 * todavía está redactando el resto, y el retardo percibido pasa a ser el de
 * generar una sola frase.
 *
 * La detección de límite de oración se delega en `splitSentences`, que ya
 * conoce las abreviaturas del español y no parte en `Dr. Pérez` ni en `3.14`.
 * La regla es simple: si al analizar el búfer aparece más de una oración, todas
 * menos la última están cerradas y se pueden emitir; la última sigue creciendo.
 */
export class SentenceStreamer {
  /**
   * @param {object} [options]
   * @param {number} [options.minLength] Longitud mínima para emitir una
   *   oración suelta. Evita que un "Sí." inicial salga como intervención
   *   independiente, lo que suena entrecortado; se acumula con la siguiente.
   */
  constructor({ minLength = 0 } = {}) {
    this.minLength = minLength;
    this.buffer = '';
    this.pending = '';
  }

  /**
   * Aporta un fragmento nuevo.
   * @param {string} delta
   * @returns {string[]} Oraciones cerradas listas para hablar. Puede ir vacío.
   */
  push(delta) {
    if (!delta) return [];
    this.buffer += delta;

    const sentences = splitSentences(this.buffer);
    if (sentences.length < 2) return [];

    // `splitSentences` normaliza y recorta, así que la última oración vuelve al
    // búfer sin su espacio final. Si no se restituye, el fragmento siguiente se
    // pega a la palabra anterior y "El Dr. Ramírez" acaba como "El Dr.Ramírez".
    const openEnded = /\s$/.test(this.buffer);

    // La última puede estar a medio escribir: se queda en el búfer.
    const closed = sentences.slice(0, -1);
    this.buffer = sentences[sentences.length - 1] + (openEnded ? ' ' : '');

    return this.#release(closed);
  }

  /**
   * Cierra el flujo y devuelve lo que quede sin emitir.
   * @returns {string[]}
   */
  flush() {
    const rest = this.buffer.trim();
    this.buffer = '';

    const out = [];
    const tail = this.pending ? `${this.pending} ${rest}`.trim() : rest;
    this.pending = '';
    if (tail) out.push(tail);

    return out;
  }

  reset() {
    this.buffer = '';
    this.pending = '';
  }

  /**
   * Aplica el mínimo de longitud, agrupando oraciones demasiado cortas con la
   * siguiente en lugar de emitirlas sueltas.
   * @param {string[]} sentences
   * @returns {string[]}
   */
  #release(sentences) {
    const out = [];

    for (const sentence of sentences) {
      const merged = this.pending ? `${this.pending} ${sentence}` : sentence;

      if (merged.length < this.minLength) {
        this.pending = merged;
        continue;
      }

      this.pending = '';
      out.push(merged);
    }

    return out;
  }
}
