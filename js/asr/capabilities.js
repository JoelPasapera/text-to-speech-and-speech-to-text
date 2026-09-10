/**
 * Detección de capacidades del reconocimiento de voz.
 *
 * La Web Speech API tiene tres realidades distintas conviviendo:
 *  - Chrome/Edge y Safari la exponen bajo `webkitSpeechRecognition`.
 *  - Firefox la mantiene tras una bandera (`dom.webspeech.recognition.enable`),
 *    así que en la práctica hay que tratarla como no disponible.
 *  - Chrome 139+ añade modo local (`processLocally`), que evita enviar audio a
 *    un servidor, pero exige instalar antes el paquete de idioma y su
 *    disponibilidad depende del navegador y del sistema operativo.
 *
 * Este módulo no toca el DOM ni mantiene estado: sólo responde preguntas.
 */

/** @returns {typeof SpeechRecognition | null} */
export function getRecognitionConstructor() {
  return globalThis.SpeechRecognition ?? globalThis.webkitSpeechRecognition ?? null;
}

/** @returns {boolean} */
export function isRecognitionSupported() {
  return getRecognitionConstructor() !== null;
}

/**
 * El reconocimiento exige contexto seguro. localhost cuenta como seguro.
 * @returns {boolean}
 */
export function isSecureContextOk() {
  return globalThis.isSecureContext === true;
}

/** @returns {boolean} Si el navegador expone siquiera la API de modo local. */
export function supportsOnDeviceApi() {
  const Ctor = getRecognitionConstructor();
  return typeof Ctor?.available === 'function' && typeof Ctor?.install === 'function';
}

/**
 * Consulta si el paquete de idioma para reconocimiento local ya está listo.
 * Devuelve un estado normalizado en vez de propagar excepciones, porque esta
 * API ha tenido regresiones y no debe tumbar el arranque de la aplicación.
 *
 * @param {string} lang Etiqueta BCP 47, p. ej. "es-PE".
 * @returns {Promise<'available'|'downloadable'|'downloading'|'unavailable'|'unsupported'>}
 */
export async function checkOnDevice(lang) {
  const Ctor = getRecognitionConstructor();
  if (!supportsOnDeviceApi()) return 'unsupported';

  try {
    const status = await Ctor.available({ langs: [lang], processLocally: true });
    // Versiones tempranas devolvían un booleano en vez de una cadena.
    if (typeof status === 'boolean') return status ? 'available' : 'unavailable';
    return status ?? 'unavailable';
  } catch {
    return 'unsupported';
  }
}

/**
 * Solicita la instalación del paquete de idioma local.
 * @param {string} lang
 * @returns {Promise<boolean>} true si quedó instalado.
 */
export async function installOnDevice(lang) {
  const Ctor = getRecognitionConstructor();
  if (!supportsOnDeviceApi()) return false;

  try {
    return (await Ctor.install({ langs: [lang], processLocally: true })) === true;
  } catch {
    return false;
  }
}

/**
 * Motivo por el que el reconocimiento no puede funcionar, o null si sí puede.
 * @returns {string|null}
 */
export function blockingReason() {
  if (!isSecureContextOk()) {
    return 'El reconocimiento necesita HTTPS. Abre la página por https:// o desde localhost.';
  }
  if (!isRecognitionSupported()) {
    return 'Este navegador no expone reconocimiento de voz. Usa Chrome, Edge o Safari.';
  }
  return null;
}
