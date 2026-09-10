import { el, setText, must } from '../util/dom.js';

/** Cómo se llama cada estado en la interfaz. */
const STATE_LABELS = {
  idle: 'Conversación detenida',
  listening: 'Te escucho',
  thinking: 'Pensando',
  speaking: 'Respondiendo',
};

/**
 * Vista del diálogo.
 *
 * Los turnos cerrados y la respuesta en curso viven en nodos distintos: la
 * respuesta cambia decenas de veces por segundo mientras el modelo genera, y
 * no debe forzar el repintado del historial completo.
 */
export class ConversationView {
  /** @param {HTMLElement} root */
  constructor(root) {
    this.root = root;
    this.thread = must('.dialogue__thread', root);
    this.status = must('.dialogue__status', root);
    this.progress = must('.dialogue__progress', root);

    this.turnsNode = el('div', { class: 'dialogue__turns' });
    this.liveNode = el('div', { class: 'turn turn--assistant turn--live' });
    this.emptyNode = el('p', { class: 'dialogue__empty' },
      'Pulsa Escuchar y di algo. Te responderá en voz alta.');

    this.liveNode.hidden = true;
    this.thread.append(this.emptyNode, this.turnsNode, this.liveNode);
    this.count = 0;
  }

  /** @param {'idle'|'listening'|'thinking'|'speaking'} state */
  setState(state) {
    setText(this.status, STATE_LABELS[state] ?? state);
    this.root.dataset.state = state;
  }

  /**
   * Añade un turno cerrado.
   * @param {'user'|'assistant'} role
   * @param {string} text
   */
  addTurn(role, text) {
    const who = role === 'user' ? 'Tú' : 'Asistente';
    const node = el('div', { class: `turn turn--${role}` },
      el('span', { class: 'turn__who' }, who),
      el('p', { class: 'turn__text' }, text),
    );

    this.turnsNode.append(node);
    this.count++;
    this.liveNode.hidden = true;
    this.emptyNode.hidden = true;
    this.#scrollToEnd();
  }

  /** Respuesta parcial mientras el modelo genera. */
  setLive(text) {
    if (!text) {
      this.liveNode.hidden = true;
      return;
    }

    if (this.liveNode.childNodes.length === 0) {
      this.liveNode.append(
        el('span', { class: 'turn__who' }, 'Asistente'),
        el('p', { class: 'turn__text' }, ''),
      );
    }

    setText(this.liveNode.querySelector('.turn__text'), text);
    this.liveNode.hidden = false;
    this.emptyNode.hidden = true;
    this.#scrollToEnd();
  }

  clear() {
    this.turnsNode.replaceChildren();
    this.liveNode.hidden = true;
    this.emptyNode.hidden = false;
    this.count = 0;
  }

  /**
   * Progreso de descarga del modelo.
   * @param {number|null} fraction 0 a 1, o null para ocultar.
   */
  setDownload(fraction) {
    if (fraction === null) {
      this.progress.hidden = true;
      return;
    }
    const pct = Math.round(fraction * 100);
    setText(this.progress, `Descargando el modelo: ${pct} %`);
    this.progress.style.setProperty('--progress', String(fraction));
    this.progress.hidden = false;
  }

  #scrollToEnd() {
    this.thread.scrollTop = this.thread.scrollHeight;
  }
}
