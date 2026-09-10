import { must, setText } from '../util/dom.js';

/** Etiquetas de estado en la voz de la interfaz: qué pasa, no cómo se llama. */
const STATE_LABELS = {
  idle: 'En reposo',
  starting: 'Abriendo micrófono',
  listening: 'Escuchando',
  suspended: 'En pausa mientras habla',
  stopping: 'Cerrando',
};

/**
 * Indicador de estado y canal de avisos.
 * Los avisos transitorios se borran solos; los definitivos permanecen.
 */
export class StatusView {
  /** @param {HTMLElement} root */
  constructor(root) {
    this.root = root;
    this.dot = must('.status__dot', root);
    this.label = must('.status__label', root);
    this.meta = must('.status__meta', root);
    this.notice = must('.status__notice', root);
    this.noticeTimer = 0;
  }

  /** @param {keyof STATE_LABELS} state */
  setState(state) {
    setText(this.label, STATE_LABELS[state] ?? state);
    this.root.dataset.state = state;
  }

  /**
   * @param {{lang: string, engine: string, words: number}} info
   */
  setMeta({ lang, engine, words }) {
    const parts = [lang, engine];
    if (words > 0) parts.push(`${words} ${words === 1 ? 'palabra' : 'palabras'}`);

    // Cada faceta es su propio elemento: el filete que las separa lo pone la
    // hoja de estilos, no un carácter de puntuación dentro del texto.
    this.meta.replaceChildren(...parts.map((part) => {
      const span = document.createElement('span');
      span.textContent = part;
      return span;
    }));
  }

  /**
   * @param {string} message
   * @param {'info'|'warn'|'error'} [tone]
   * @param {number} [autoHideMs] 0 para que permanezca.
   */
  showNotice(message, tone = 'info', autoHideMs = 6000) {
    clearTimeout(this.noticeTimer);
    setText(this.notice, message);
    this.notice.dataset.tone = tone;
    this.notice.hidden = false;

    if (autoHideMs > 0) {
      this.noticeTimer = setTimeout(() => this.clearNotice(), autoHideMs);
    }
  }

  clearNotice() {
    clearTimeout(this.noticeTimer);
    this.notice.hidden = true;
    setText(this.notice, '');
  }
}
