import { must } from './util/dom.js';
import { Recognizer } from './asr/recognizer.js';
import { TranscriptStore } from './asr/transcript-store.js';
import { blockingReason, checkOnDevice, installOnDevice, supportsOnDeviceApi } from './asr/capabilities.js';
import { Synthesizer } from './tts/synthesizer.js';
import { Spectrogram } from './audio/spectrogram.js';
import { TranscriptView } from './ui/transcript-view.js';
import { StatusView } from './ui/status-view.js';
import { ComposerView } from './ui/composer-view.js';
import { LanguageModelBridge, describeAvailability } from './nlp/language-model.js';
import { Conversation, SYSTEM_PROMPT } from './nlp/conversation.js';
import { ConversationView } from './ui/conversation-view.js';

/**
 * Punto de composición.
 *
 * Es el único módulo que conoce a todos los demás. Los de dominio se comunican
 * por eventos y no se referencian entre sí, de modo que sustituir cualquiera
 * de ellos (por ejemplo, cambiar el reconocedor del navegador por un motor
 * propio sobre WebGPU) toca sólo este archivo.
 */

const DEFAULT_LANG = 'es-PE';
const WORKLET_URL = new URL('./audio/worklets/pcm-tap.js', import.meta.url).href;

function main() {
  const statusView = new StatusView(must('#status'));

  const blocked = blockingReason();
  if (blocked) {
    statusView.setState('idle');
    statusView.showNotice(blocked, 'error', 0);
    must('#listen').disabled = true;
    return;
  }

  const store = new TranscriptStore();
  const recognizer = new Recognizer({ lang: DEFAULT_LANG, maxAlternatives: 3 });
  const synth = new Synthesizer();
  const spectrogram = new Spectrogram(must('#spectrogram'));

  new TranscriptView(must('#transcript'), store);
  const composer = new ComposerView(must('#composer'), synth);

  const model = new LanguageModelBridge({ language: 'es', systemPrompt: SYSTEM_PROMPT });
  const conversation = new Conversation(model);
  const dialogue = new ConversationView(must('#dialogue'));

  const state = {
    lang: DEFAULT_LANG,
    engine: 'motor en línea',
    micVisual: false,
    /** 'dictado' | 'conversacion' */
    mode: 'dictado',
  };

  const refreshMeta = () => {
    statusView.setMeta({ lang: state.lang, engine: state.engine, words: store.wordCount });
  };

  // --- Reconocimiento → almacén -------------------------------------------

  recognizer.on('final', (segment) => {
    store.commit(segment);
    refreshMeta();
    // La transcripción cruda se guarda siempre: en modo conversación sigue
    // siendo el registro de lo que el micrófono entendió, que es justo lo que
    // hace falta cuando el asistente responde algo que no viene a cuento.
    conversation.addFinal(segment.text);
  });

  recognizer.on('interim', ({ text }) => {
    store.setInterim(text);
    conversation.noteInterim(text);
  });

  recognizer.on('state', ({ state: next }) => {
    statusView.setState(next);

    // "Activo" incluye la suspensión: el usuario sigue en modo dictado aunque
    // el micrófono esté cerrado un momento porque el lector está hablando.
    const active = next === 'listening' || next === 'starting' || next === 'suspended';
    const listen = must('#listen');
    listen.textContent = active ? 'Detener' : 'Escuchar';
    listen.dataset.active = String(active);
    document.body.dataset.mic = active ? 'open' : 'closed';
  });

  recognizer.on('error', ({ message, fatal }) => {
    statusView.showNotice(message, fatal ? 'error' : 'warn', fatal ? 0 : 5000);
  });

  recognizer.on('notice', ({ message }) => {
    state.engine = 'motor en línea';
    refreshMeta();
    statusView.showNotice(message, 'warn');
  });

  // --- Compuerta half-duplex ----------------------------------------------
  // Mientras suena la voz sintética el micrófono la capta y el reconocedor la
  // transcribe como si fuera el usuario. Cerrar la sesión durante el habla es
  // la solución barata; la cara sería cancelación de eco con un filtro NLMS.

  const REOPEN_DELAY_MS = 200;

  synth.on('start', ({ chunks }) => {
    recognizer.suspend();
    if (state.mode === 'dictado') {
      composer.setSpeaking(true);
      composer.setProgress(0, chunks);
    }
  });

  synth.on('chunk', ({ index, total }) => {
    if (state.mode === 'dictado') composer.setProgress(index, total);
  });

  synth.on('end', ({ cancelled }) => {
    composer.setSpeaking(false);
    composer.setProgress(0, 0);

    if (state.mode === 'conversacion') {
      // El turno vuelve al usuario. Quien reabre el micrófono es la máquina de
      // estados de la conversación, no esto, para que haya un solo dueño.
      if (!cancelled) conversation.noteSpeechFinished();
      return;
    }

    // Pequeño margen para que la cola de audio del sistema se vacíe antes de
    // reabrir el micrófono: sin él se cuela la cola de la última sílaba.
    setTimeout(() => recognizer.resume(), REOPEN_DELAY_MS);
  });

  synth.on('error', ({ message }) => statusView.showNotice(message, 'warn'));

  // --- Conversación --------------------------------------------------------

  conversation.on('state', ({ state: next }) => {
    dialogue.setState(next);

    // Durante la generación el micrófono sobra: la conversación ya descarta lo
    // que llegue, y dejarlo abierto gasta sesiones del motor de reconocimiento
    // sin motivo, que es justo lo que dispara el estrangulamiento antiabuso.
    if (next === 'thinking') recognizer.suspend();
    if (next === 'listening') setTimeout(() => recognizer.resume(), REOPEN_DELAY_MS);
  });

  conversation.on('turn', (turn) => {
    if (turn.reset) {
      dialogue.clear();
      return;
    }
    dialogue.addTurn(turn.role, turn.text);
    if (turn.role === 'assistant') dialogue.setLive('');
  });

  conversation.on('delta', ({ text }) => dialogue.setLive(text));

  // Cada oración completa se manda a hablar en cuanto se cierra, sin esperar a
  // que el modelo termine: la primera frase suena mientras se genera el resto.
  conversation.on('say', ({ text, done }) => {
    if (done) {
      synth.endStream();
      return;
    }
    if (!synth.streamOpen) synth.beginStream();
    synth.enqueue(text);
  });

  conversation.on('error', ({ message }) => statusView.showNotice(message, 'warn'));

  model.on('download', ({ progress }) => dialogue.setDownload(progress));
  model.on('error', ({ message }) => statusView.showNotice(message, 'warn', 0));

  // --- Controles -----------------------------------------------------------

  must('#listen').addEventListener('click', async () => {
    if (recognizer.desired === 'listening') {
      recognizer.stop();
      spectrogram.stop();
      state.micVisual = false;
      return;
    }

    statusView.clearNotice();
    recognizer.start();

    // El espectrograma es un extra: si el navegador niega la captura directa,
    // el dictado debe seguir funcionando igual.
    if (!state.micVisual) {
      try {
        await spectrogram.start(WORKLET_URL);
        state.micVisual = true;
      } catch {
        must('#spectrogram').hidden = true;
      }
    }
  });

  must('#clear').addEventListener('click', () => {
    store.clear();
    refreshMeta();
  });

  must('#undo').addEventListener('click', () => {
    store.undo();
    refreshMeta();
  });

  must('#copy').addEventListener('click', async () => {
    const text = store.toText();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      statusView.showNotice('Transcripción copiada.', 'info', 2500);
    } catch {
      statusView.showNotice('El navegador bloqueó el portapapeles.', 'warn');
    }
  });

  must('#to-composer').addEventListener('click', () => {
    const text = store.toText();
    if (!text) {
      statusView.showNotice('Todavía no hay nada transcrito.', 'info', 2500);
      return;
    }
    composer.setText(text);
    must('#tts-text').focus();
  });

  must('#lang').addEventListener('change', (event) => {
    state.lang = event.target.value;
    recognizer.setLanguage(state.lang);
    refreshMeta();
    void refreshLocalAvailability();
  });

  // --- Cambio de modo ------------------------------------------------------

  function applyMode(mode) {
    state.mode = mode;
    const conversando = mode === 'conversacion';

    must('#composer').hidden = conversando;
    must('#dialogue').hidden = !conversando;
    document.body.dataset.mode = mode;
    refreshMeta();
  }

  /**
   * Prepara el modelo. Se llama desde un clic a propósito: Chrome exige
   * activación del usuario para iniciar la descarga, y sin ella `create()`
   * falla sin explicar por qué.
   */
  async function enterConversation() {
    const status = await model.probe();

    if (status === 'unavailable') {
      statusView.showNotice(describeAvailability(status), 'warn', 0);
      must('#mode-dictado').checked = true;
      applyMode('dictado');
      return false;
    }

    if (status !== 'available') {
      statusView.showNotice(describeAvailability(status), 'info', 0);
      dialogue.setDownload(0);
    }

    const ready = await model.open();
    dialogue.setDownload(null);

    if (!ready) {
      must('#mode-dictado').checked = true;
      applyMode('dictado');
      return false;
    }

    statusView.clearNotice();
    conversation.start();
    return true;
  }

  for (const input of document.querySelectorAll('input[name="mode"]')) {
    input.addEventListener('change', async (event) => {
      const mode = event.target.value;

      if (mode === 'dictado') {
        conversation.stop();
        synth.cancel();
        applyMode('dictado');
        if (recognizer.desired === 'listening') recognizer.resume();
        return;
      }

      applyMode('conversacion');
      await enterConversation();
    });
  }

  must('#dialogue-reset').addEventListener('click', () => conversation.clearHistory());

  must('#dialogue-stop').addEventListener('click', () => {
    conversation.abort();
    synth.cancel();
    conversation.noteSpeechFinished();
  });

  // --- Modo local ----------------------------------------------------------

  const localToggle = must('#local-mode');

  async function refreshLocalAvailability() {
    if (!supportsOnDeviceApi()) {
      localToggle.disabled = true;
      must('#local-hint').textContent = 'Este navegador no ofrece reconocimiento en el dispositivo.';
      return;
    }

    const status = await checkOnDevice(state.lang);
    const ready = status === 'available';

    localToggle.disabled = status === 'unsupported' || status === 'unavailable';
    must('#local-hint').textContent = {
      available: 'Listo: el audio no sale del equipo.',
      downloadable: 'Requiere descargar el paquete de idioma la primera vez.',
      downloading: 'Descargando el paquete de idioma…',
      unavailable: 'No hay paquete local para esta variante del español.',
      unsupported: 'Este navegador no ofrece reconocimiento en el dispositivo.',
    }[status] ?? '';

    if (!ready && localToggle.checked) {
      localToggle.checked = false;
      recognizer.preferLocal = false;
      state.engine = 'motor en línea';
      refreshMeta();
    }
  }

  localToggle.addEventListener('change', async () => {
    if (!localToggle.checked) {
      recognizer.preferLocal = false;
      state.engine = 'motor en línea';
      refreshMeta();
      return;
    }

    const status = await checkOnDevice(state.lang);

    if (status === 'downloadable' || status === 'downloading') {
      statusView.showNotice('Descargando el paquete de idioma. Puede tardar.', 'info', 0);
      const ok = await installOnDevice(state.lang);
      statusView.clearNotice();
      if (!ok) {
        localToggle.checked = false;
        statusView.showNotice('No se pudo instalar el paquete de idioma.', 'warn');
        return;
      }
    } else if (status !== 'available') {
      localToggle.checked = false;
      statusView.showNotice('El reconocimiento local no está disponible aquí.', 'warn');
      return;
    }

    recognizer.preferLocal = true;
    state.engine = 'en el dispositivo';
    refreshMeta();

    // Reabrir la sesión para que tome el modo nuevo.
    if (recognizer.desired === 'listening') recognizer.setLanguage(state.lang);
  });

  // --- Ciclo de vida -------------------------------------------------------

  spectrogram.onLevel = (level) => {
    must('#level').style.setProperty('--level', level.toFixed(3));
  };

  globalThis.addEventListener('resize', () => spectrogram.resize());

  // La síntesis pendiente sobrevive a la navegación en algunos navegadores.
  globalThis.addEventListener('pagehide', () => {
    synth.cancel();
    conversation.dispose();
    model.dispose();
    recognizer.dispose();
    spectrogram.stop();
  });

  statusView.setState('idle');
  refreshMeta();

  composer.init(DEFAULT_LANG).then(({ count }) => {
    if (count === 0) {
      statusView.showNotice(
        'No hay voces en español instaladas en el sistema. Añádelas desde los ajustes de voz del sistema operativo.',
        'warn',
        0,
      );
    }
  });

  void refreshLocalAvailability();

  // Sondeo inicial sin descargar nada: sólo para saber si el modo conversación
  // es siquiera ofrecible en este equipo. Si no lo es, se deshabilita con el
  // motivo a la vista y el dictado sigue funcionando exactamente igual.
  model.probe().then((status) => {
    const usable = status !== 'unavailable';
    must('#mode-conversacion').disabled = !usable;
    must('#mode-hint').textContent = describeAvailability(status);
  });

  // Señal para el guardia de arranque de index.html: si esta línea no se
  // alcanza, la página se explica sola en vez de quedarse muda.
  globalThis.__vozArrancada = true;
}

main();
