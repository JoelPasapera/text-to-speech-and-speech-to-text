/**
 * Ayudas de DOM. Sin framework: sólo azúcar sobre la API nativa.
 */

/**
 * @param {string} selector
 * @param {ParentNode} [root]
 * @returns {Element}
 */
export function must(selector, root = document) {
  const el = root.querySelector(selector);
  if (!el) throw new Error(`DOM: no se encontró "${selector}"`);
  return el;
}

/**
 * Crea un elemento con atributos e hijos en una sola expresión.
 * @param {string} tag
 * @param {Object} [attrs]
 * @param {...(Node|string)} children
 */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value !== null && value !== undefined) node.setAttribute(key, value);
  }
  for (const child of children) {
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

/** Escribe texto sólo si cambió: evita relayouts innecesarios. */
export function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}
