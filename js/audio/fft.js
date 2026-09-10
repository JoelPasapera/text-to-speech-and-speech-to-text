/**
 * FFT radix-2 iterativa (Cooley-Tukey), in-place, sobre Float32Array.
 *
 * Decisiones de implementación:
 *  - Tablas de twiddle y permutación de bit-reversal precalculadas en el
 *    constructor: el bucle caliente no ejecuta ni un Math.cos ni una división.
 *  - Partes real e imaginaria en arrays separados (SoA en vez de intercalado):
 *    mejor localidad y sin cálculo de índices pares/impares.
 *  - Para señales reales se usa el truco de empaquetado: N muestras reales se
 *    meten en una FFT compleja de N/2 y se deshace con una pasada de
 *    "split", lo que da ~2x frente a rellenar la parte imaginaria con ceros.
 *
 * Uso típico:
 *   const fft = new RealFFT(1024);
 *   fft.magnitudes(samples, out);   // out.length === 513
 */
export class FFT {
  /** @param {number} n Tamaño de la transformada. Debe ser potencia de dos. */
  constructor(n) {
    if (n < 2 || (n & (n - 1)) !== 0) {
      throw new RangeError(`FFT: el tamaño debe ser potencia de dos, se recibió ${n}`);
    }

    this.n = n;
    this.levels = Math.log2(n) | 0;

    // Twiddles: cos/sin de -2*PI*k/n para k en [0, n/2).
    this.cos = new Float32Array(n >> 1);
    this.sin = new Float32Array(n >> 1);
    for (let k = 0; k < n >> 1; k++) {
      const angle = (-2 * Math.PI * k) / n;
      this.cos[k] = Math.cos(angle);
      this.sin[k] = Math.sin(angle);
    }

    // Permutación de bit-reversal precalculada.
    this.rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < this.levels; b++) r |= ((i >>> b) & 1) << (this.levels - 1 - b);
      this.rev[i] = r;
    }
  }

  /**
   * Transformada compleja in-place. re/im se sobrescriben con el resultado.
   * @param {Float32Array} re
   * @param {Float32Array} im
   */
  forward(re, im) {
    const { n, rev, cos, sin } = this;

    // Reordenamiento por bit-reversal. La guarda i < r evita deshacer el swap.
    for (let i = 0; i < n; i++) {
      const r = rev[i];
      if (i < r) {
        let t = re[i]; re[i] = re[r]; re[r] = t;
        t = im[i]; im[i] = im[r]; im[r] = t;
      }
    }

    // Mariposas por niveles. `stride` mapea el índice del twiddle al nivel.
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const stride = n / size;
      for (let base = 0; base < n; base += size) {
        for (let j = 0, k = 0; j < half; j++, k += stride) {
          const a = base + j;
          const b = a + half;
          const wr = cos[k];
          const wi = sin[k];
          const xr = re[b] * wr - im[b] * wi;
          const xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr;
          im[b] = im[a] - xi;
          re[a] += xr;
          im[a] += xi;
        }
      }
    }
  }
}

/**
 * FFT especializada para entrada real de tamaño N.
 * Internamente ejecuta una FFT compleja de N/2 y separa el espectro.
 * Produce N/2 + 1 bins útiles (de DC a Nyquist).
 */
export class RealFFT {
  /** @param {number} n Número de muestras reales. Potencia de dos, >= 4. */
  constructor(n) {
    if (n < 4 || (n & (n - 1)) !== 0) {
      throw new RangeError(`RealFFT: el tamaño debe ser potencia de dos >= 4, se recibió ${n}`);
    }

    this.n = n;
    this.bins = (n >> 1) + 1;

    const half = n >> 1;
    this.fft = new FFT(half);
    this.re = new Float32Array(half);
    this.im = new Float32Array(half);

    // Twiddles del paso de separación: e^(-i*PI*k/half) para k en [0, half].
    this.splitCos = new Float32Array(half + 1);
    this.splitSin = new Float32Array(half + 1);
    for (let k = 0; k <= half; k++) {
      const angle = (-Math.PI * k) / half;
      this.splitCos[k] = Math.cos(angle);
      this.splitSin[k] = Math.sin(angle);
    }

    // Buffers de salida reutilizados: cero asignaciones en el bucle caliente.
    this.outRe = new Float32Array(this.bins);
    this.outIm = new Float32Array(this.bins);
  }

  /**
   * Calcula el espectro complejo de `input`.
   * @param {Float32Array} input Exactamente `n` muestras reales.
   * @returns {{re: Float32Array, im: Float32Array}} Vistas internas reutilizadas.
   */
  forward(input) {
    if (input.length !== this.n) {
      throw new RangeError(`RealFFT: se esperaban ${this.n} muestras, llegaron ${input.length}`);
    }

    const half = this.n >> 1;
    const { re, im, outRe, outIm, splitCos, splitSin } = this;

    // Empaquetado: las muestras pares van a la parte real, las impares a la imaginaria.
    for (let i = 0, j = 0; i < half; i++, j += 2) {
      re[i] = input[j];
      im[i] = input[j + 1];
    }

    this.fft.forward(re, im);

    // Separación: reconstruye el espectro de N puntos a partir del de N/2.
    for (let k = 0; k <= half; k++) {
      const kk = k === half ? 0 : k;
      const mk = (half - k) % half;

      // Parte par (simétrica conjugada) e impar (antisimétrica conjugada).
      const evenRe = 0.5 * (re[kk] + re[mk]);
      const evenIm = 0.5 * (im[kk] - im[mk]);
      const oddRe = 0.5 * (im[kk] + im[mk]);
      const oddIm = -0.5 * (re[kk] - re[mk]);

      const wr = splitCos[k];
      const wi = splitSin[k];

      outRe[k] = evenRe + (oddRe * wr - oddIm * wi);
      outIm[k] = evenIm + (oddRe * wi + oddIm * wr);
    }

    return { re: outRe, im: outIm };
  }

  /**
   * Magnitud lineal por bin. Escribe en `out` para evitar asignaciones.
   * @param {Float32Array} input Exactamente `n` muestras reales.
   * @param {Float32Array} out Longitud `bins`.
   */
  magnitudes(input, out) {
    const { re, im } = this.forward(input);
    for (let k = 0; k < this.bins; k++) {
      out[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
    }
    return out;
  }
}

/**
 * Ventana de Hann precalculada. Periódica (denominador N, no N-1), que es la
 * variante correcta para análisis espectral con solapamiento.
 * @param {number} n
 * @returns {Float32Array}
 */
export function hannWindow(n) {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / n));
  return w;
}
