import { must, el, setText } from '../util/dom.js';
import { loadVoices, spanishVoices, describeVoice } from '../tts/voice-registry.js';

/**
 * Panel de "decir en voz alta".
 *
 * Responsabilidades: poblar el selector de voces, exponer velocidad y tono, y
 * pedir al sintetizador que hable. No sabe nada del reconocedor; quien conecta
 * ambos es el punto de composición.
 */
export class ComposerView {
  /**
   * @param {HTMLElement} root
   * @param {import('../tts/synthesizer.js').Synthesizer} synth
   */
  constructor(root, synth) {
    this.root = root;
    this.synth = synth;

    this.textarea = must('#tts-text', root);
    this.voiceSelect = must('#tts-voice', root);
    this.rateInput = must('#tts-rate', root);
    this.pitchInput = must('#tts-pitch', root);
    this.rateValue = must('#tts-rate-value', root);
    this.pitchValue = must('#tts-pitch-value', root);
    this.speakButton = must('#tts-speak', root);
    this.stopButton = must('#tts-stop', root);

    /** @type {SpeechSynthesisVoice[]} */
    this.voices = [];

    this.#bind();
    this.#syncParams();
  }

  /** Carga las voces del sistema y selecciona la mejor candidata en español. */
  async init(preferredRegion) {
    const all = await loadVoices();
    this.voices = spanishVoices(all, preferredRegion);

    this.voiceSelect.replaceChildren();

    if (this.voices.length === 0) {
      this.voiceSelect.append(el('option', { value: '' }, 'No hay voces en español instaladas'));
      this.voiceSelect.disabled = true;
      this.speakButton.disabled = true;
      return { count: 0, voice: null };
    }

    this.voices.forEach((voice, index) => {
      this.voiceSelect.append(el('option', { value: String(index) }, describeVoice(voice)));
    });

    this.voiceSelect.disabled = false;
    this.voiceSelect.value = '0';
    this.synth.setVoice(this.voices[0]);

    return { count: this.voices.length, voice: this.voices[0] };
  }

  /** @param {string} text Sustituye el contenido del área de texto. */
  setText(text) {
    this.textarea.value = text;
    this.#updateSpeakState();
  }

  /** @param {boolean} speaking */
  setSpeaking(speaking) {
    this.speakButton.hidden = speaking;
    this.stopButton.hidden = !speaking;
    this.root.dataset.speaking = String(speaking);
  }

  /** Resalta el fragmento en curso para que se vea el avance de la lectura. */
  setProgress(index, total) {
    setText(must('#tts-progress', this.root), total > 1 ? `${index + 1} de ${total}` : '');
  }

  #bind() {
    this.voiceSelect.addEventListener('change', () => {
      const voice = this.voices[Number(this.voiceSelect.value)] ?? null;
      this.synth.setVoice(voice);
    });

    this.rateInput.addEventListener('input', () => this.#syncParams());
    this.pitchInput.addEventListener('input', () => this.#syncParams());

    this.textarea.addEventListener('input', () => this.#updateSpeakState());

    this.speakButton.addEventListener('click', () => {
      this.synth.speak(this.textarea.value);
    });

    this.stopButton.addEventListener('click', () => {
      this.synth.cancel();
    });

    // Ctrl/Cmd + Enter para hablar sin soltar el teclado.
    this.textarea.addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        this.synth.speak(this.textarea.value);
      }
    });
  }

  #syncParams() {
    const rate = Number(this.rateInput.value);
    const pitch = Number(this.pitchInput.value);

    this.synth.setParams({ rate, pitch });
    setText(this.rateValue, `${rate.toFixed(2)}×`);
    setText(this.pitchValue, pitch.toFixed(2));
  }

  #updateSpeakState() {
    this.speakButton.disabled = this.textarea.value.trim().length === 0
      || this.voices.length === 0;
  }
}
