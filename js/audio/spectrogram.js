import { RealFFT, hannWindow } from './fft.js';

/**
 * Espectrograma en vivo del micrófono.
 *
 * Cadena completa: getUserMedia → AudioWorklet → ventana de Hann → FFT real →
 * magnitud en dB → mapeo logarítmico de frecuencia → LUT de color → canvas.
 *
 * Dos decisiones que no son las obvias:
 *
 *  - No se usa AnalyserNode. Su FFT es una caja negra con suavizado temporal
 *    fijo y escala lineal de frecuencia, que aplasta justo la banda donde viven
 *    los formantes del habla. Con FFT propia se controla ventana, solapamiento
 *    y rango dinámico.
 *
 *  - El eje vertical es logarítmico entre 60 Hz y 8 kHz. En escala lineal la
 *    voz ocupa la quinta parte inferior de la imagen y el resto queda negro.
 *
 * El render desplaza el propio canvas un píxel a la izquierda y pinta la
 * columna nueva en el borde derecho: evita mantener un historial en memoria y
 * el blit va por GPU.
 */

const FFT_SIZE = 1024;
const HOP_SIZE = 512;
const DB_FLOOR = -95;
const DB_CEIL = -18;
const FREQ_MIN = 60;
const FREQ_MAX = 8000;

/** Paradas del mapa de color: de fondo frío a pico cálido. */
const COLOR_STOPS = [
  [0.0, 0x12, 0x16, 0x22],
  [0.22, 0x27, 0x2c, 0x6e],
  [0.45, 0x6d, 0x39, 0x9c],
  [0.68, 0xc2, 0x44, 0x7d],
  [0.86, 0xed, 0x88, 0x45],
  [1.0, 0xff, 0xe4, 0xb5],
];

export class Spectrogram {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    this.ctx.imageSmoothingEnabled = false;

    this.fft = new RealFFT(FFT_SIZE);
    this.window = hannWindow(FFT_SIZE);
    this.magnitudes = new Float32Array(this.fft.bins);

    // Buffer de análisis con solapamiento: se desplaza HOP y se rellena al final.
    this.frame = new Float32Array(FFT_SIZE);
    this.windowed = new Float32Array(FFT_SIZE);

    this.lut = buildColorLut();

    /** @type {MediaStream|null} */
    this.stream = null;
    /** @type {AudioContext|null} */
    this.audioContext = null;
    /** @type {AudioWorkletNode|null} */
    this.node = null;

    this.rowStart = null;
    this.rowEnd = null;
    this.column = null;
    this.running = false;
    this.peakLevel = 0;

    this.onLevel = null; // callback opcional: nivel RMS normalizado [0,1]
  }

  /**
   * Abre el micrófono y arranca el análisis.
   * @param {string} workletUrl Ruta al módulo del worklet.
   * @returns {Promise<void>}
   * @throws Si no hay permiso o el navegador no soporta la captura.
   */
  async start(workletUrl) {
    if (this.running) return;

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    this.audioContext = new (globalThis.AudioContext ?? globalThis.webkitAudioContext)();
    await this.audioContext.audioWorklet.addModule(workletUrl);

    this.#buildFrequencyMap(this.audioContext.sampleRate);
    this.#resize();

    const source = this.audioContext.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.audioContext, 'pcm-tap', {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      processorOptions: { hopSize: HOP_SIZE },
    });

    this.node.port.onmessage = (event) => this.#consume(event.data);
    source.connect(this.node);

    // Safari suspende el contexto hasta que hay un gesto de usuario.
    if (this.audioContext.state === 'suspended') await this.audioContext.resume();

    this.running = true;
  }

  stop() {
    this.running = false;

    this.node?.port.postMessage('stop');
    this.node?.disconnect();
    this.node = null;

    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;

    this.audioContext?.close();
    this.audioContext = null;

    this.#clear();
  }

  /** Recalcula el tamaño del lienzo tras un cambio de layout. */
  resize() {
    if (!this.rowStart) return;
    this.#resize();
  }

  // --- Interno -------------------------------------------------------------

  #resize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);

    const width = Math.max(1, Math.round(rect.width * dpr));
    const height = Math.max(1, Math.round(rect.height * dpr));

    // El `rowStart === null` no sobra: si el tamaño calculado coincidiera por
    // casualidad con el que trae el lienzo por defecto, el mapa de filas nunca
    // se construiría y no se pintaría una sola columna.
    const sized = this.rowStart !== null;
    if (sized && this.canvas.width === width && this.canvas.height === height) return;

    this.canvas.width = width;
    this.canvas.height = height;
    this.ctx.imageSmoothingEnabled = false;

    this.column = this.ctx.createImageData(1, height);
    this.#buildRowMap(height);
    this.#clear();
  }

  #clear() {
    const [, r, g, b] = COLOR_STOPS[0];
    this.ctx.fillStyle = `rgb(${r},${g},${b})`;
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }

  /** Frecuencia central de cada bin, dependiente de la tasa de muestreo real. */
  #buildFrequencyMap(sampleRate) {
    this.sampleRate = sampleRate;
    this.binHz = sampleRate / FFT_SIZE;
  }

  /**
   * Precalcula, para cada fila del lienzo, el rango de bins que le corresponde.
   * Con el eje logarítmico las filas graves cubren menos de un bin y las agudas
   * cubren varios; tomar el máximo del rango evita perder picos por submuestreo.
   */
  #buildRowMap(height) {
    this.rowStart = new Uint16Array(height);
    this.rowEnd = new Uint16Array(height);

    const maxBin = this.fft.bins - 1;
    const ratio = Math.log(FREQ_MAX / FREQ_MIN);

    for (let y = 0; y < height; y++) {
      // y = 0 es la fila superior y le toca la frecuencia más alta.
      const tTop = 1 - y / height;
      const tBottom = 1 - (y + 1) / height;

      const fTop = FREQ_MIN * Math.exp(ratio * tTop);
      const fBottom = FREQ_MIN * Math.exp(ratio * tBottom);

      let lo = Math.floor(fBottom / this.binHz);
      let hi = Math.ceil(fTop / this.binHz);

      lo = Math.min(Math.max(lo, 0), maxBin);
      hi = Math.min(Math.max(hi, lo + 1), maxBin);

      this.rowStart[y] = lo;
      this.rowEnd[y] = hi;
    }
  }

  /** @param {Float32Array} block Bloque de HOP_SIZE muestras. */
  #consume(block) {
    if (!this.running || !this.column) return;

    // Desplazar el buffer de análisis y anexar el bloque nuevo: solapamiento
    // del 50 % entre tramas consecutivas.
    this.frame.copyWithin(0, block.length);
    this.frame.set(block, FFT_SIZE - block.length);

    // Nivel RMS para el indicador, antes de ventanear.
    let sum = 0;
    for (let i = 0; i < block.length; i++) sum += block[i] * block[i];
    const rms = Math.sqrt(sum / block.length);
    this.peakLevel = Math.max(rms, this.peakLevel * 0.88);
    this.onLevel?.(Math.min(this.peakLevel * 6, 1));

    for (let i = 0; i < FFT_SIZE; i++) this.windowed[i] = this.frame[i] * this.window[i];
    this.fft.magnitudes(this.windowed, this.magnitudes);

    this.#renderColumn();
  }

  #renderColumn() {
    const { ctx, canvas, column, magnitudes, rowStart, rowEnd, lut } = this;
    const height = canvas.height;
    const pixels = column.data;
    const range = DB_CEIL - DB_FLOOR;

    // Normalización coherente: la ventana de Hann tiene ganancia 0.5 y la FFT
    // reparte la energía de un tono real entre dos bins simétricos.
    const scale = 4 / FFT_SIZE;

    for (let y = 0; y < height; y++) {
      let peak = 0;
      for (let bin = rowStart[y]; bin <= rowEnd[y]; bin++) {
        const m = magnitudes[bin];
        if (m > peak) peak = m;
      }

      const db = 20 * Math.log10(peak * scale + 1e-12);
      let t = (db - DB_FLOOR) / range;
      t = t < 0 ? 0 : t > 1 ? 1 : t;

      const index = ((t * 255) | 0) * 3;
      const offset = y << 2;
      pixels[offset] = lut[index];
      pixels[offset + 1] = lut[index + 1];
      pixels[offset + 2] = lut[index + 2];
      pixels[offset + 3] = 255;
    }

    // Desplazar la imagen existente y pintar la columna nueva al borde derecho.
    ctx.drawImage(canvas, -1, 0);
    ctx.putImageData(column, canvas.width - 1, 0);
  }
}

/**
 * Tabla de 256 colores interpolando linealmente entre las paradas.
 * @returns {Uint8ClampedArray} Tripletas RGB planas.
 */
function buildColorLut() {
  const lut = new Uint8ClampedArray(256 * 3);

  for (let i = 0; i < 256; i++) {
    const t = i / 255;

    let s = 0;
    while (s < COLOR_STOPS.length - 2 && t > COLOR_STOPS[s + 1][0]) s++;

    const [t0, r0, g0, b0] = COLOR_STOPS[s];
    const [t1, r1, g1, b1] = COLOR_STOPS[s + 1];
    const k = t1 === t0 ? 0 : (t - t0) / (t1 - t0);

    const o = i * 3;
    lut[o] = r0 + (r1 - r0) * k;
    lut[o + 1] = g0 + (g1 - g0) * k;
    lut[o + 2] = b0 + (b1 - b0) * k;
  }

  return lut;
}
