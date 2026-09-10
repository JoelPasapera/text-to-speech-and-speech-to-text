/**
 * Troceado de texto para síntesis.
 *
 * Chrome corta los enunciados largos: pasado cierto número de caracteres el
 * habla se interrumpe a media frase sin disparar error. La única defensa fiable
 * es no entregarle nunca un enunciado largo, así que se trocea por oraciones y
 * se encolan por separado.
 *
 * El corte tiene que respetar la prosodia: partir en mitad de una frase suena
 * peor que no partir. El orden de preferencia es fin de oración, luego pausa
 * fuerte (punto y coma, dos puntos), luego coma, y sólo como último recurso un
 * espacio cualquiera.
 *
 * Particularidades del español que se contemplan:
 *  - Signos de apertura ¿ ¡ : abren oración y no deben quedar huérfanos.
 *  - Abreviaturas frecuentes (Sr., Dra., Ud., etc.) cuyo punto no cierra frase.
 *  - Decimales y ordinales con punto: 3.14, 1.º
 *  - Puntos suspensivos, que sí cierran.
 */

const MAX_CHUNK = 180;

/** Abreviaturas cuyo punto no termina oración. Sin el punto final. */
const ABBREVIATIONS = new Set([
  'sr', 'sra', 'srta', 'dr', 'dra', 'lic', 'ing', 'arq', 'prof', 'mtro',
  'ud', 'uds', 'vd', 'vds', 'av', 'avda', 'c', 'dpto', 'depto', 'ref',
  'núm', 'num', 'nro', 'pág', 'pag', 'cap', 'art', 'fig', 'tel', 'ext',
  'etc', 'aprox', 'máx', 'min', 'ee', 'uu', 'aa', 'pp', 'vol', 'ed',
  'ejem', 'ej', 'p', 'a', 'sig', 'ss', 'vs', 'ca', 'sto', 'sta', 'san',
]);

/**
 * Divide el texto en oraciones.
 * @param {string} text
 * @returns {string[]}
 */
export function splitSentences(text) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return [];

  const sentences = [];
  let start = 0;

  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i];
    if (ch !== '.' && ch !== '?' && ch !== '!' && ch !== '…') continue;

    // Absorbe la secuencia completa de cierre: "?!", "...", "?»"
    let end = i;
    while (end + 1 < normalized.length && '.?!…'.includes(normalized[end + 1])) end++;
    while (end + 1 < normalized.length && '"»”\')]'.includes(normalized[end + 1])) end++;

    if (ch === '.' && !closesSentence(normalized, i, end)) {
      i = end;
      continue;
    }

    // Sólo cierra si lo que sigue es espacio y luego principio de oración.
    const next = normalized[end + 1];
    if (next !== undefined && next !== ' ') {
      i = end;
      continue;
    }

    sentences.push(normalized.slice(start, end + 1).trim());
    start = end + 1;
    i = end;
  }

  const tail = normalized.slice(start).trim();
  if (tail) sentences.push(tail);

  return sentences;
}

/**
 * Decide si un punto en `index` termina realmente la oración.
 * @param {string} text
 * @param {number} index
 * @param {number} end Última posición del grupo de puntuación.
 */
function closesSentence(text, index, end) {
  // Puntos suspensivos o combinaciones: siempre cierran.
  if (end > index) return true;

  const before = text[index - 1];
  const after = text[index + 1];

  // Decimal o versión: 3.14, 1.2.3
  if (/\d/.test(before ?? '') && /\d/.test(after ?? '')) return false;

  // Ordinal abreviado: 1.º, 2.ª
  if (/\d/.test(before ?? '') && /[ºªoa]/.test(after ?? '')) return false;

  // Inicial de nombre: J. Pérez
  let wordStart = index - 1;
  while (wordStart >= 0 && /[^\s]/.test(text[wordStart])) wordStart--;
  const word = text.slice(wordStart + 1, index).toLowerCase();

  if (word.length === 1 && /[a-záéíóúñ]/.test(word)) return false;
  if (ABBREVIATIONS.has(word)) return false;

  return true;
}

/**
 * Trocea el texto en fragmentos que el sintetizador pueda tragar enteros.
 * @param {string} text
 * @param {number} [maxLength]
 * @returns {string[]}
 */
export function chunkForSpeech(text, maxLength = MAX_CHUNK) {
  const chunks = [];

  for (const sentence of splitSentences(text)) {
    if (sentence.length <= maxLength) {
      chunks.push(sentence);
      continue;
    }
    for (const piece of splitLongSentence(sentence, maxLength)) chunks.push(piece);
  }

  return chunks;
}

/**
 * Parte una oración que excede el presupuesto, buscando el corte más natural
 * disponible dentro del límite.
 * @param {string} sentence
 * @param {number} maxLength
 * @returns {string[]}
 */
function splitLongSentence(sentence, maxLength) {
  const pieces = [];
  let rest = sentence;

  while (rest.length > maxLength) {
    const window = rest.slice(0, maxLength + 1);

    // Preferencia decreciente de puntos de corte.
    let cut = Math.max(
      window.lastIndexOf('; '),
      window.lastIndexOf(': '),
      window.lastIndexOf(' — '),
    );
    if (cut > 0) cut += 1;

    if (cut <= 0) {
      cut = window.lastIndexOf(', ');
      if (cut > 0) cut += 1;
    }
    if (cut <= 0) cut = window.lastIndexOf(' ');

    // Palabra única más larga que el presupuesto: corte duro, sin alternativa.
    if (cut <= 0) cut = maxLength;

    const piece = rest.slice(0, cut).trim();
    if (piece) pieces.push(piece);
    rest = rest.slice(cut).trim();
  }

  if (rest) pieces.push(rest);
  return pieces;
}
