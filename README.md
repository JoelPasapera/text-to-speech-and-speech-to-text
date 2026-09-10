# Voz y letra

Dictado y lectura en voz alta en español, en el navegador. Sin frameworks, sin
build, sin dependencias: módulos ES nativos servidos tal cual.

## Estructura

```
index.html
css/styles.css
js/
  main.js                    punto de composición, el único que conoce a todos
  core/event-bus.js          pub/sub mínimo para desacoplar dominio y vistas
  asr/
    capabilities.js          detección de soporte y de modo local
    recognizer.js            máquina de estados sobre SpeechRecognition
    transcript-store.js      dueño del texto acumulado entre sesiones
  tts/
    voice-registry.js        carga y ordenación de voces del sistema
    text-chunker.js          segmentación de oraciones en español
    synthesizer.js           cola, latido anti-corte y control de parámetros
  audio/
    fft.js                   FFT radix-2 y FFT real, tablas precalculadas
    spectrogram.js           captura, análisis y render del espectrograma
    worklets/pcm-tap.js      AudioWorkletProcessor que entrega PCM por bloques
  nlp/
    language-model.js        envoltura sobre la Prompt API de Chrome
    sentence-streamer.js     emite oraciones completas desde un flujo de texto
    conversation.js          turnos, endpointing por silencio e historial
  ui/
    transcript-view.js       render de segmentos e hipótesis en curso
    composer-view.js         panel de síntesis
    conversation-view.js     hilo del diálogo y progreso de descarga
    status-view.js           indicador de estado y avisos
  util/dom.js                azúcar sobre la API nativa del DOM
```

Los módulos de dominio no se referencian entre sí ni tocan el DOM: emiten
eventos. El cableado vive entero en `main.js`, de modo que reemplazar cualquier
pieza (por ejemplo, cambiar el reconocimiento del navegador por un motor propio
sobre WebGPU) toca un solo archivo.

## Ejecutar

Los módulos ES y el AudioWorklet no funcionan desde `file://`. Hace falta un
servidor, y `getUserMedia` exige contexto seguro:

```sh
python3 -m http.server 8000
# abrir http://localhost:8000
```

En producción, HTTPS obligatorio. No hay paso de compilación: subir la carpeta
tal cual a cualquier hospedaje estático es suficiente.

## Lo que hay que saber antes de tocarlo

**El reconocimiento por defecto no es local.** Chrome envía el audio a un
servicio remoto. La casilla «Procesar en el dispositivo» activa
`processLocally`, disponible desde Chrome 139, previa descarga del paquete de
idioma; su disponibilidad depende del navegador y del sistema operativo, y ha
tenido regresiones, así que el código degrada al motor en línea si falla.

**Firefox no sirve.** Mantiene la API tras la bandera
`dom.webspeech.recognition.enable`. Chrome, Edge y Safari sí.

**`continuous` no es continuo.** El motor cierra la sesión tras unos segundos
de silencio. `recognizer.js` distingue el cierre del motor del que pidió el
usuario y reabre con espera creciente. Cada sesión reinicia sus índices de
resultado, por eso quien acumula el texto es `transcript-store.js`.

**La síntesis se corta sola.** Chrome trunca los enunciados largos y detiene la
cola pasados unos quince segundos. De ahí el troceado por oraciones y el latido
`pause()`/`resume()` en `synthesizer.js`.

**En iOS el primer `speak()` debe salir de un toque.** No hay forma de evitarlo;
el sintetizador avisa si `start` nunca llega.

**Medio dúplex a propósito.** Mientras el lector habla, el micrófono se cierra.
Sin esto el reconocedor transcribe la propia voz sintética. La alternativa real
para permitir interrupciones sería cancelación de eco con un filtro adaptativo
NLMS sobre la señal de referencia.

**El espectrograma es prescindible.** Abre el micrófono por su cuenta con
`getUserMedia`, en paralelo al que abre el reconocedor. Si el navegador lo
niega, se oculta y el dictado sigue funcionando.

## Modo conversación

Usa el modelo integrado en Chrome (Gemini Nano) a través de la Prompt API. No
hay claves, ni servidor, ni coste: el modelo se descarga una vez y la
inferencia ocurre en el equipo.

Requisitos, que son duros: Chrome 148 o superior en Windows 10/11, macOS 13+,
Linux o Chromebook Plus; 22 GB libres en el volumen del perfil; y GPU con más
de 4 GB de VRAM, o CPU con 16 GB de RAM y cuatro núcleos. En móvil no existe.
Si el volumen baja de 10 GB libres, Chrome borra el modelo y hay que
redescargarlo.

Cuando no se cumple, el modo aparece deshabilitado con el motivo a la vista y
el dictado sigue funcionando exactamente igual. La comprobación se hace al
arrancar con `LanguageModel.availability()`, sin descargar nada.

### Las tres decisiones que importan

**Saber cuándo terminó de hablar el usuario.** Es el problema difícil, no la
llamada al modelo. El reconocedor entrega finales por segmentos, y un final no
es un fin de turno: quien dice "necesito que me expliques", piensa un segundo y
sigue con "cómo funciona esto" produce dos finales y un solo turno. Se resuelve
con endpointing por silencio: cualquier señal de voz reinicia un temporizador y
el turno se cierra cuando expira.

**Hablar antes de terminar de generar.** Esperar la respuesta completa deja al
usuario varios segundos en silencio. `sentence-streamer.js` consume el flujo
del modelo y emite cada oración en cuanto se cierra, de modo que la primera
suena mientras se redacta el resto. Reutiliza el segmentador del sintetizador,
que ya sabe que `Dr.` y `3.14` no terminan frase. Su salida es idéntica venga
el flujo en trozos de un carácter o de quinientos.

**Escribir el prompt para el oído, no para la vista.** Las viñetas, los
títulos y el markdown que se ojean bien en pantalla suenan pésimo leídos en
alto, y cinco párrafos son cuarenta segundos de monólogo. La instrucción de
sistema pide dos o tres frases, sin formato, con los números escritos como se
pronuncian.

### Límites conocidos

No hay interrupción por voz. Mientras el asistente habla el micrófono está
cerrado, así que para cortarle hay que usar el botón. La alternativa sería
cancelación de eco con un filtro adaptativo, que es un proyecto aparte.

La Prompt API no está disponible en Web Workers, de modo que la inferencia
corre en el hilo principal. Por eso todo el consumo es en streaming: es lo
único que evita congelar la interfaz.

## Por qué hay una FFT escrita a mano

`AnalyserNode` habría bastado para dibujar barras. No basta para un
espectrograma útil de voz: su FFT es opaca, aplica un suavizado temporal fijo y
sólo ofrece escala lineal de frecuencia, que comprime los formantes del habla
en la quinta parte inferior de la imagen.

`fft.js` es radix-2 iterativa con bit-reversal y twiddles precalculados, partes
real e imaginaria en arrays separados, y la variante real empaqueta N muestras
en una transformada compleja de N/2. El eje vertical del espectrograma es
logarítmico entre 60 Hz y 8 kHz, con el rango de bins de cada fila precalculado.

Validada contra una DFT ingenua: error relativo del orden de 5×10⁻⁸, que es el
épsilon de `Float32Array`.

## Siguiente paso natural

El punto de extensión está en `main.js`. Sustituir `Recognizer` por un motor
propio (pesos de Whisper, runtime en WGSL) sólo exige emitir los mismos eventos
`state`, `interim`, `final` y `error`. El resto de la aplicación no se entera.
La cadena de DSP que haría falta —ventana, FFT, banco mel— ya está en `audio/`.

Lo mismo vale para el modelo: `LanguageModelBridge` expone `probe`, `open`,
`ask` y `close`. Un motor sobre Transformers.js o WebLLM que respete esa forma
entra sin tocar `conversation.js` ni las vistas.
