// Generates the dark and the high-contrast ("sun") themes from style.css at build time, so the
// themes never drift from the main stylesheet. Every rule that sets a colour gets an override
// under :root[data-theme=…] with its colours remapped in OKLab; layout is never touched.

const COLOR_PROPS =
  /^(color|background|background-color|background-image|border|border-(top|right|bottom|left)|border(-(top|right|bottom|left))?-color|outline|outline-color|fill|stroke|box-shadow|text-shadow|text-decoration-color|caret-color|accent-color)$/;

// Parts of the page that keep their colours in every theme: the header, the sidebar, primary
// buttons, toasts and the current step are already dark green with light text, and the marks drawn
// on top of the photo must match the photo.
const KEEP =
  /\.topbar|\.brand|\.top-|\.lang-picker|\.private-label|\.live-dot|\.sidebar|\.dropzone|\.upload-mark|\.source-|\.local-note|\.side-btn|#sourceCount|#resultOverlay|\.frame-|\.loupe|\.map-wrap|\.primary|\.toast|\.flow-steps \.current|::backdrop/;

// Strips comments and splits the stylesheet into rules and at-rule blocks.
export function parseCss(text) {
  text = text.replace(/\/\*[\s\S]*?\*\//g, '');
  let i = 0;
  function block() {
    const nodes = [];
    while (i < text.length) {
      const rest = text.slice(i),
        lead = rest.match(/^\s*/)[0].length;
      i += lead;
      if (i >= text.length) break;
      if (text[i] === '}') {
        i++;
        break;
      }
      let j = i,
        depth = 0;
      while (j < text.length && !(depth === 0 && (text[j] === '{' || text[j] === ';'))) {
        if (text[j] === '(') depth++;
        if (text[j] === ')') depth--;
        j++;
      }
      const head = text.slice(i, j).trim();
      if (text[j] === ';') {
        nodes.push({ type: 'statement', text: head });
        i = j + 1;
        continue;
      }
      i = j + 1;
      if (head.startsWith('@')) {
        if (/^@(media|supports|layer)\b/.test(head))
          nodes.push({ type: 'at', head, children: block() });
        else nodes.push({ type: 'opaque', head, body: skip() });
      } else nodes.push({ type: 'rule', selector: head, decls: declarations(skip()) });
    }
    return nodes;
  }
  function skip() {
    const start = i;
    let depth = 1;
    while (i < text.length && depth) {
      if (text[i] === '{') depth++;
      if (text[i] === '}') depth--;
      i++;
    }
    return text.slice(start, i - 1);
  }
  return block();
}

function declarations(body) {
  const out = [];
  let depth = 0,
    start = 0;
  for (let k = 0; k <= body.length; k++) {
    const c = body[k];
    if (c === '(') depth++;
    if (c === ')') depth--;
    if ((c === ';' && !depth) || k === body.length) {
      const part = body.slice(start, k).trim();
      start = k + 1;
      const m = part.match(/^([-\w]+)\s*:\s*([\s\S]+)$/);
      if (m) out.push([m[1].toLowerCase(), m[2].replace(/\s+/g, ' ').trim()]);
    }
  }
  return out;
}

// sRGB hex ↔ OKLab (Björn Ottosson).
const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const gam = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
export function hexToOklab(hex) {
  let h = hex.slice(1);
  if (h.length <= 4) h = [...h].map((c) => c + c).join('');
  const [r, g, b] = [0, 2, 4].map((k) => lin(parseInt(h.slice(k, k + 2), 16) / 255)),
    alpha = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b),
    m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b),
    s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
    alpha,
  };
}
export function oklabToHex({ L, a, b, alpha = 1 }) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3,
    m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3,
    s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const rgb = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  const hex = (v) =>
    Math.round(Math.min(1, Math.max(0, v)) * 255)
      .toString(16)
      .padStart(2, '0');
  return '#' + rgb.map((c) => hex(gam(Math.max(0, c)))).join('') + (alpha < 1 ? hex(alpha) : '');
}

const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
const KIND = (prop) =>
  prop === 'color' || prop === 'fill' || prop === 'caret-color' || prop.startsWith('text-')
    ? 'text'
    : prop.startsWith('border') || prop.startsWith('outline') || prop === 'stroke'
      ? 'line'
      : 'surface';

// Dark: lightness is mirrored, so every pair keeps its contrast; colour is toned down a little.
// Surfaces land on a dark grey-green rather than black; text is lifted more, so it keeps a
// contrast of at least 7:1 on the page.
export function darkColor(c, kind = 'surface') {
  const L =
    kind === 'text' ? 1.05 - 0.75 * c.L : kind === 'line' ? 0.97 - 0.6 * c.L : 0.97 - 0.68 * c.L;
  return { ...c, L: clamp(L), a: c.a * 0.85, b: c.b * 0.85 };
}
// Sun: light surfaces become paper-white, text and lines get much darker, status colours stronger.
export function sunColor(c, kind) {
  const chroma = Math.hypot(c.a, c.b);
  if (kind === 'text') return { ...c, L: c.L > 0.75 ? c.L : clamp(c.L * 0.5) };
  if (kind === 'line') return { ...c, L: c.L > 0.75 ? clamp(c.L * 0.62) : clamp(c.L * 0.6) };
  if (c.L < 0.6) return { ...c, L: clamp(c.L * 0.75) };
  // Tinted light surfaces (yellow "check", red "error", green "done") must stay recognisable.
  if (chroma > 0.012) return { ...c, L: clamp(c.L - 0.03), a: c.a * 1.8, b: c.b * 1.8 };
  return { ...c, L: clamp(1 - (1 - c.L) * 0.35) };
}

const NAMED = { white: '#ffffff', black: '#000000' };
function mapValue(prop, value, theme) {
  // Soft decorative shadows are dropped; rings (no blur) keep their meaning.
  if (/^(box|text)-shadow$/.test(prop) && !/^(inset )?0 0 0 /.test(value)) return 'none';
  return remap(prop, value, theme);
}
function remap(prop, value, theme) {
  const kind = KIND(prop);
  return value.replace(/#[0-9a-fA-F]{3,8}\b|\b(white|black)\b/g, (m) => {
    const lab = hexToOklab(NAMED[m] ?? m);
    return oklabToHex(theme === 'dark' ? darkColor(lab, kind) : sunColor(lab, kind));
  });
}

function scope(selector, theme, auto) {
  const root = auto ? `:root[data-theme='auto']` : `:root[data-theme='${theme}']`;
  return selector
    .split(/,(?![^(]*\))/)
    .map((s) => s.trim())
    .map((s) => (/^(:root|html)\b/.test(s) ? s.replace(/^(:root|html)/, root) : `${root} ${s}`))
    .join(',\n');
}

function emit(nodes, theme, auto) {
  const out = [];
  for (const n of nodes) {
    if (n.type === 'at') {
      const inner = emit(n.children, theme, auto);
      if (inner) out.push(`${n.head} {\n${inner}\n}`);
    }
    if (n.type !== 'rule') continue;
    // Kept parts are repeated with their own colours: a more general themed rule would otherwise
    // outrank the original rule now that it carries the theme selector.
    const keep = KEEP.test(n.selector);
    const decls = n.decls.filter(([p]) => COLOR_PROPS.test(p));
    // Only rules that set an actual colour are themed, but then all their colour declarations are
    // repeated (also "transparent"), so overrides keep the original cascade between rules.
    if (!decls.some(([p, v]) => /#[0-9a-fA-F]{3,8}\b|\b(white|black)\b/.test(v))) continue;
    out.push(
      `${scope(n.selector, theme, auto)} {\n${decls.map(([p, v]) => `  ${p}: ${keep ? v : mapValue(p, v, theme)};`).join('\n')}\n}`,
    );
  }
  return out.join('\n');
}

export function themeCss(css) {
  const tree = parseCss(css);
  return [
    '/* Generated by scripts/themes.mjs from the rules above: dark and high-contrast themes. */',
    `:root[data-theme='dark'] { color-scheme: dark; }`,
    emit(tree, 'dark', false),
    `@media (prefers-color-scheme: dark) {\n:root[data-theme='auto'] { color-scheme: dark; }\n${emit(tree, 'dark', true)}\n}`,
    emit(tree, 'sun', false),
  ].join('\n');
}
