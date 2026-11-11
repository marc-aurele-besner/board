// Terminal colours that follow the board's theme. Programs pick their own RGB colours for a dark or a light
// terminal (the Claude CLI paints its prompt box dark grey and its text near white), which on the other theme
// gives dark bars and white on white. Each colour is adapted to the current theme instead: a background made for
// the other theme has its lightness flipped, and text is moved until it reads on what is behind it, keeping its
// hue. The 16 ANSI colours are theme tokens already (css --ansi-*).

const MIN_CONTRAST = 4.5;

const hex = (value) => {
  const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(value.trim());
  return m ? m.slice(1).map((x) => parseInt(x, 16)) : null;
};
const rgbOf = (value) => {
  const m = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/.exec(value);
  return m ? m.slice(1).map(Number) : hex(value);
};
const css = ([r, g, b]) => `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`;

function luminance([r, g, b]) {
  const lin = (c) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
const contrast = (a, b) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

function toHsl([r, g, b]) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}
function fromHsl([h, s, l]) {
  if (!s) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const ch = (t) => {
    t = (t + 1) % 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [ch(h + 1 / 3) * 255, ch(h) * 255, ch(h - 1 / 3) * 255];
}
const flip = (rgb) => {
  const [h, s, l] = toHsl(rgb);
  return fromHsl([h, s, 1 - l]);
};

// The theme as the terminal shows it: its background and text, and the 16 ANSI colours, read from the CSS tokens.
export function readTheme() {
  const style = getComputedStyle(document.documentElement);
  const get = (name) => style.getPropertyValue(name);
  const bg = hex(get('--surface-2')) ?? [229, 234, 236];
  const text = hex(get('--text')) ?? [17, 26, 30];
  const ansi = Array.from({ length: 16 }, (_, n) => hex(get(`--ansi-${n}`)) ?? text);
  return { bg, text, ansi, dark: luminance(bg) < 0.2, key: `${get('--surface-2')}|${get('--text')}`.replace(/\s/g, '') };
}

// A background colour for this theme: one clearly made for the other theme is flipped.
function themedBg(rgb, theme) {
  const lum = luminance(rgb);
  return theme.dark ? (lum > 0.45 ? flip(rgb) : rgb) : lum < 0.18 ? flip(rgb) : rgb;
}

// Text moved, if needed, until it reads on `behind`: flipped first, then darkened or lightened step by step.
function readable(rgb, behind) {
  if (contrast(rgb, behind) >= MIN_CONTRAST) return rgb;
  const flipped = flip(rgb);
  let best = contrast(flipped, behind) > contrast(rgb, behind) ? flipped : rgb;
  const [h, s, l0] = toHsl(best);
  const darker = luminance(behind) > 0.18;
  for (let l = l0, i = 0; i < 30 && contrast(best, behind) < MIN_CONTRAST; i++) {
    l = Math.min(1, Math.max(0, l + (darker ? -0.035 : 0.035)));
    best = fromHsl([h, s, l]);
  }
  return best;
}

const cache = new Map();

// Colours for one span. `fg` and `bg` are what the program asked for: an ANSI index, a 256-colour index turned
// into 'rgb(…)', or 'rgb(…)'; undefined for the default. Returns CSS values, '' for the default.
export function themedColors(fg, bg, inverse, theme) {
  const id = `${fg}|${bg}|${inverse ? 1 : 0}|${theme.key}`;
  if (cache.has(id)) return cache.get(id);
  // The 16 colours stay theme tokens; only a colour the program chose itself is adapted.
  const token = (v) => typeof v === 'number' && v < 16;
  const raw = (v, fallback) => (v === undefined ? fallback : token(v) ? theme.ansi[v] : rgbOf(v));
  let out;
  if (inverse) {
    // Swapped: the text colour becomes the background. It is meant to stand out, so it is not flipped.
    const back = raw(fg, theme.text);
    const front = readable(raw(bg, theme.bg), back);
    out = { fg: css(front), bg: css(back) };
  } else {
    const backRgb = bg === undefined ? theme.bg : token(bg) ? theme.ansi[bg] : themedBg(rgbOf(bg), theme);
    const back = bg === undefined ? '' : token(bg) ? `var(--ansi-${bg})` : css(backRgb);
    let front = '';
    if (fg !== undefined) {
      if (token(fg) && contrast(theme.ansi[fg], backRgb) >= 3) front = `var(--ansi-${fg})`;
      else front = css(readable(raw(fg, theme.text), backRgb));
    } else if (bg !== undefined) {
      // Default text on a coloured background: the theme's text colour, unless it does not read there.
      front = contrast(theme.text, backRgb) >= MIN_CONTRAST ? '' : css(readable(theme.text, backRgb));
    }
    out = { fg: front, bg: back };
  }
  if (cache.size > 2000) cache.clear();
  cache.set(id, out);
  return out;
}
