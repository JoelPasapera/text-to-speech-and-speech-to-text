/**
 * Bus de eventos mínimo. Existe para que los módulos de dominio (ASR, TTS,
 * audio) no conozcan nada del DOM ni entre sí: emiten, y quien quiera escucha.
 *
 * Cada módulo tiene su propia instancia; no hay un bus global compartido, para
 * que el acoplamiento siga siendo explícito en el punto de composición.
 */
export class EventBus {
  constructor() {
    /** @type {Map<string, Set<Function>>} */
    this.channels = new Map();
  }

  /**
   * @param {string} type
   * @param {Function} handler
   * @returns {() => void} Función para cancelar la suscripción.
   */
  on(type, handler) {
    let set = this.channels.get(type);
    if (!set) {
      set = new Set();
      this.channels.set(type, set);
    }
    set.add(handler);
    return () => set.delete(handler);
  }

  /**
   * Un error en un suscriptor no debe impedir que los demás reciban el evento.
   * @param {string} type
   * @param {*} [payload]
   */
  emit(type, payload) {
    const set = this.channels.get(type);
    if (!set) return;
    for (const handler of set) {
      try {
        handler(payload);
      } catch (err) {
        console.error(`EventBus: fallo en el manejador de "${type}"`, err);
      }
    }
  }

  clear() {
    this.channels.clear();
  }
}
