/**
 * AudioWorkletProcessor que entrega bloques de PCM al hilo principal.
 *
 * El grafo de audio invoca `process` con quantos de 128 muestras, un tamaño
 * inservible para análisis espectral. Este procesador los acumula hasta
 * completar un salto ("hop") y entonces envía el bloque.
 *
 * Se envía el buffer como transferible: la propiedad pasa al hilo principal
 * sin copiar. Por eso se asigna uno nuevo en cada envío en lugar de reutilizar
 * (un buffer transferido queda desacoplado y no se puede volver a escribir).
 *
 * No se usa SharedArrayBuffer a propósito: exigiría cabeceras COOP/COEP en el
 * servidor, lo que complica el despliegue en hospedaje estático. A este ritmo
 * de mensajes el coste de asignación es despreciable.
 */
class PcmTapProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { hopSize = 512 } = options.processorOptions ?? {};
    this.hopSize = hopSize;
    this.accumulator = new Float32Array(hopSize);
    this.filled = 0;
    this.running = true;

    this.port.onmessage = (event) => {
      if (event.data === 'stop') this.running = false;
    };
  }

  process(inputs) {
    if (!this.running) return false;

    const channel = inputs[0]?.[0];
    if (!channel) return true; // Sin entrada todavía: mantener vivo el nodo.

    const { accumulator, hopSize } = this;
    let read = 0;

    while (read < channel.length) {
      const take = Math.min(hopSize - this.filled, channel.length - read);
      accumulator.set(channel.subarray(read, read + take), this.filled);
      this.filled += take;
      read += take;

      if (this.filled === hopSize) {
        const block = new Float32Array(accumulator);
        this.port.postMessage(block, [block.buffer]);
        this.filled = 0;
      }
    }

    return true;
  }
}

registerProcessor('pcm-tap', PcmTapProcessor);
