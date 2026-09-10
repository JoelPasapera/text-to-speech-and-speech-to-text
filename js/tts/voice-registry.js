/**
 * Inventario de voces del sistema.
 *
 * `speechSynthesis.getVoices()` devuelve una lista vacía en la primera llamada
 * en Chrome: las voces llegan de forma asíncrona y avisan por `voiceschanged`.
 * Este módulo encapsula esa espera para que nadie más tenga que saberlo.
 */

const VOICE_TIMEOUT_MS = 3000;

/**
 * Resuelve cuando las voces están cargadas. Si el evento nunca llega, devuelve
 * lo que haya en vez de colgarse.
 * @returns {Promise<SpeechSynthesisVoice[]>}
 */
export function loadVoices() {
  return new Promise((resolve) => {
    const immediate = speechSynthesis.getVoices();
    if (immediate.length > 0) {
      resolve(immediate);
      return;
    }

    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      speechSynthesis.removeEventListener('voiceschanged', finish);
      clearTimeout(timer);
      resolve(speechSynthesis.getVoices());
    };

    const timer = setTimeout(finish, VOICE_TIMEOUT_MS);
    speechSynthesis.addEventListener('voiceschanged', finish);
  });
}

/**
 * Voces en español, ordenadas por utilidad: primero las locales (funcionan sin
 * conexión y con menor latencia), luego por región.
 * @param {SpeechSynthesisVoice[]} voices
 * @param {string} [preferredRegion] p. ej. "es-PE"
 * @returns {SpeechSynthesisVoice[]}
 */
export function spanishVoices(voices, preferredRegion = 'es-PE') {
  const region = preferredRegion.toLowerCase();

  return voices
    .filter((v) => v.lang.toLowerCase().startsWith('es'))
    .sort((a, b) => {
      const aExact = a.lang.toLowerCase() === region ? 0 : 1;
      const bExact = b.lang.toLowerCase() === region ? 0 : 1;
      if (aExact !== bExact) return aExact - bExact;
      if (a.localService !== b.localService) return a.localService ? -1 : 1;
      return a.name.localeCompare(b.name, 'es');
    });
}

/**
 * Etiqueta legible para el selector. Distingue local de remota porque cambia
 * el comportamiento sin conexión.
 * @param {SpeechSynthesisVoice} voice
 * @returns {string}
 */
export function describeVoice(voice) {
  const origin = voice.localService ? 'sin conexión' : 'en línea';
  return `${voice.name} (${voice.lang}, ${origin})`;
}
