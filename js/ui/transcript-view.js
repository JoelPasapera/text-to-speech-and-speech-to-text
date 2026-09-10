import { el, setText } from '../util/dom.js';

/**
 * Vista de la transcripción. Sólo lee del almacén y pinta; no decide nada.
 *
 * Los segmentos confirmados y la hipótesis en curso se mantienen en nodos
 * separados: el parcial cambia varias veces por segundo y no debe forzar el
 * repintado de todo lo ya dicho.
 */
export class TranscriptView {
  /**
   * @param {HTMLElement} root
   * @param {import('../asr/transcript-store.js').TranscriptStore} store
   */
  constructor(root, store) {
    this.root = root;
    this.store = store;

    this.segmentsNode = el('div', { class: 'transcript__segments' });
    this.interimNode = el('span', { class: 'transcript__interim' });
    this.emptyNode = el('p', { class: 'transcript__empty' },
      'Pulsa Escuchar y habla. Lo que digas aparecerá aquí.');

    this.root.append(this.emptyNode, this.segmentsNode, this.interimNode);
    this.renderedCount = 0;

    store.on('change', (segments) => this.#renderSegments(segments));
    store.on('interim', (text) => this.#renderInterim(text));
  }

  #renderSegments(segments) {
    // Reconstrucción completa sólo si hubo borrado; si no, anexar lo nuevo.
    if (segments.length < this.renderedCount) {
      this.segmentsNode.replaceChildren();
      this.renderedCount = 0;
    }

    for (let i = this.renderedCount; i < segments.length; i++) {
      const segment = segments[i];
      const node = el('span', { class: 'transcript__segment' }, segment.text + ' ');

      // Marcar sólo lo dudoso. Anotar cada segmento con su confianza sería
      // ruido: lo útil es ver de un vistazo qué conviene revisar.
      if (segment.confidence !== null && segment.confidence < 0.65) {
        node.classList.add('transcript__segment--uncertain');
        node.title = `Confianza ${(segment.confidence * 100).toFixed(0)} %`;
      }

      this.segmentsNode.append(node);
    }

    this.renderedCount = segments.length;
    this.#updateEmptyState();
    this.#scrollToEnd();
  }

  #renderInterim(text) {
    setText(this.interimNode, text);
    this.#updateEmptyState();
    if (text) this.#scrollToEnd();
  }

  #updateEmptyState() {
    this.emptyNode.hidden = !this.store.isEmpty;
  }

  #scrollToEnd() {
    this.root.scrollTop = this.root.scrollHeight;
  }
}
