/**
 * Shared DOM snapshot extractor.
 *
 * Both the baseline generator and the parity test normalise through this one module. That matters: a
 * baseline produced by different code than the app snapshot could hide exactly the drift the test
 * exists to catch.
 *
 * The extractor records structure, not presentation — tag names, `id`, `class`, the attribute set, and
 * text — because structure is what "the original UI, not a redesign" means in practice.
 */

/**
 * Attributes that legitimately differ between a static template and the running application:
 *
 *   - `alt` / `src`: image sources are runtime object URLs and the original sets `alt=""`, which React
 *     omits rather than rendering as an empty attribute.
 *
 * Everything else must match, and any attribute outside this set plus the originals' vocabulary is
 * reported as a finding rather than silently ignored.
 */
export const VOLATILE_ATTRIBUTES = ['alt', 'src'];

/**
 * Elements whose text is expected to change while the app runs, so their content is not compared.
 * Their element, attributes and position are still compared.
 */
export const VOLATILE_TEXT_IDS = ['status', 'zoom', 'canvasHint', 'presentationAuto', 'fontLicenseText'];

/** Runs inside the page: walks the document and returns a comparable tree. */
export const EXTRACT_IN_PAGE = `(() => {
  const VOLATILE_TEXT = ${JSON.stringify(VOLATILE_TEXT_IDS)};
  const VOLATILE_ATTRS = new Set(${JSON.stringify(VOLATILE_ATTRIBUTES)});

  function styleKey(value) {
    // Compare style declarations as an ordered set of properties so formatting differences between
    // the template and React's inline style serialisation do not register as a UI change.
    return value
      .split(';')
      .map(part => part.trim())
      .filter(Boolean)
      .map(part => {
        const [name, ...rest] = part.split(':');
        return name.trim() + ':' + rest.join(':').trim().replace(/\\s+/g, ' ');
      });
  }

  function walk(element) {
    const attributes = {};
    for (const attr of element.attributes) {
      if (VOLATILE_ATTRS.has(attr.name)) continue;
      attributes[attr.name] = attr.name === 'style' ? styleKey(attr.value) : attr.value;
    }

    const ownText = [...element.childNodes]
      .filter(node => node.nodeType === Node.TEXT_NODE)
      .map(node => node.nodeValue.replace(/\\s+/g, ' ').trim())
      .filter(Boolean)
      .join(' ');

    return {
      tag: element.tagName.toLowerCase(),
      attributes,
      text: VOLATILE_TEXT.includes(element.id) ? null : ownText,
      children: [...element.children].map(walk),
    };
  }

  return {
    nodes: document.body.querySelectorAll('*').length,
    body: [...document.body.children]
      .filter(child => child.tagName !== 'SCRIPT')
      .map(walk),
  };
})()`;

/** Attribute names the original project is allowed to use, plus the ones its own JS creates. */
export const ALLOWED_ATTRIBUTES = new Set([
  // Present in the original templates.
  'accept',
  'alt',
  'aria-label',
  'aria-labelledby',
  'aria-live',
  'autocomplete',
  'class',
  'data-tool',
  'id',
  'max',
  'maxlength',
  'min',
  'placeholder',
  'role',
  'step',
  'style',
  'tabindex',
  'title',
  'type',
  'value',
  // Created by the original's DOM-building code.
  'data-cover',
  'data-cover-color',
  'data-id',
  'data-port',
  'data-product',
  // Attributes the original's own DOM-building code sets at runtime: image `loading`, and the canvas
  // backing store that `resize()` sizes to the container.
  'loading',
  'width',
  'height',
  // Boolean attributes the browser and the original's code set.
  'checked',
  'disabled',
  'hidden',
  'open',
  'selected',
  'src',
]);

/** Stable, comparable form of an extracted snapshot. */
export function normaliseSnapshot(snapshot) {
  const findings = [];
  let count = 0;

  function visit(node, depth) {
    count += 1;
    for (const name of Object.keys(node.attributes)) {
      if (!ALLOWED_ATTRIBUTES.has(name))
        findings.push(`${name} on <${node.tag}>${node.attributes.id ? `#${node.attributes.id}` : ''}`);
    }
    node.children.forEach(child => visit(child, depth + 1));
  }

  snapshot.body.forEach(node => visit(node, 0));
  return { nodes: count, unexpectedAttributes: [...new Set(findings)].sort(), body: snapshot.body };
}

/** Flattens a snapshot to `path -> description` lines for readable diff output. */
export function describe(snapshot) {
  const lines = [];
  function visit(node, pathParts) {
    const id = node.attributes.id ? `#${node.attributes.id}` : '';
    const cls = node.attributes.class ? `.${node.attributes.class.split(/\s+/).join('.')}` : '';
    const at = `${pathParts.join('>') || 'body'}>${node.tag}${id}${cls}`;
    const attrs = Object.entries(node.attributes)
      .filter(([name]) => name !== 'id' && name !== 'class')
      .map(([name, value]) => `${name}=${JSON.stringify(value)}`)
      .sort();
    lines.push(
      `${at}${node.text ? ` text=${JSON.stringify(node.text)}` : ''}${attrs.length ? ` [${attrs.join(' ')}]` : ''}`,
    );
    node.children.forEach((child, index) => visit(child, [...pathParts, `${node.tag}[${index}]`]));
  }
  snapshot.body.forEach((node, index) => visit(node, [`body[${index}]`]));
  return lines;
}
