// A small terminal emulator for the Dev section: enough of xterm for shells, test runners, progress bars and
// full-screen programs such as the Claude CLI. It keeps a grid of cells and the lines that scrolled off the top;
// modules/dev.js draws them. No dependency.
//
// A line is { cells, v }: cells[x] is { c, k } (a character and a style key) or undefined for a blank,
// and v changes whenever the line does, so a drawn line can be reused until then.

/**
 * @typedef {{ c: string, k: string }} Cell
 * @typedef {{ cells: (Cell | undefined)[], v: number }} Line
 * @typedef {{ fg?: number | string, bg?: number | string, bold?: boolean, dim?: boolean, italic?: boolean, under?: boolean,
 *   inverse?: boolean, strike?: boolean, cls?: string, link?: string }} Style
 * @typedef {ReturnType<typeof createTerminal>} Terminal
 */

const HISTORY_MAX = 5000;
const TAB = 8;

/** @returns {Line} */
const blankLine = () => ({ cells: [], v: 0 });
const touch = (/** @type {Line} */ line) => {
  line.v++;
  return line;
};

// Styles are shared by key: '' is the default.
/** @type {Map<string, Style>} */
const styles = new Map([['', {}]]);
const keyOf = (/** @type {Style} */ s) => {
  const key = [s.fg ?? '', s.bg ?? '', s.bold ? 'b' : '', s.dim ? 'd' : '', s.italic ? 'i' : '', s.under ? 'u' : '', s.inverse ? 'r' : '', s.strike ? 's' : '', s.cls ?? '', s.link ?? ''].join('|');
  if (!styles.has(key)) styles.set(key, { ...s });
  return key === '|||||||||' ? '' : key;
};
export const styleOf = (/** @type {string} */ key) => styles.get(key) ?? {};

// The 256-colour palette above the first 16, as CSS colours. The first 16 follow the theme (see css --ansi-*).
/** @param {number | string} n */
export function colorOf(n) {
  if (typeof n === 'string') return n;
  if (n < 16) return `var(--ansi-${n})`;
  if (n < 232) {
    const i = n - 16;
    const step = (/** @type {number} */ v) => (v ? 55 + v * 40 : 0);
    return `rgb(${step(Math.floor(i / 36))}, ${step(Math.floor(i / 6) % 6)}, ${step(i % 6)})`;
  }
  const g = 8 + (n - 232) * 10;
  return `rgb(${g}, ${g}, ${g})`;
}

// `reply` sends answers to the program (cursor position, device attributes, background colour).
/**
 * @param {{ cols?: number, rows?: number, reply?: (answer: string) => void, background?: (which: 'fg' | 'bg') => string }} [options]
 */
export function createTerminal({ cols = 100, rows = 30, reply = () => {}, background = () => '' } = {}) {
  const t = {
    cols,
    rows,
    history: /** @type {Line[]} */ ([]),
    trimmed: 0, // lines dropped from the start of history, so a view can tell what it already drew
    screen: Array.from({ length: rows }, blankLine),
    main: /** @type {{ screen: Line[], x: number, y: number } | null} */ (null), // the normal screen while the alternate one is shown
    x: 0,
    y: 0,
    top: 0,
    bottom: rows - 1,
    style: /** @type {Style} */ ({}),
    key: '',
    saved: /** @type {{ x: number, y: number, style: Style } | null} */ (null),
    cursor: true,
    appCursor: false,
    paste: false,
    mouse: false, // the program asked for mouse reports (1000, 1002, 1003); wheel turns go to it
    mouseSgr: false, // reports as CSI < b;x;y M (1006) rather than the old byte form
    state: 'text',
    seq: '',
  };

  const line = (y = t.y) => t.screen[y];
  const clampX = () => (t.x = Math.min(Math.max(t.x, 0), t.cols - 1));
  const clampY = () => (t.y = Math.min(Math.max(t.y, 0), t.rows - 1));

  /** @param {Line} l */
  function pushHistory(l) {
    if (!t.main) keepLine(l); // the alternate screen keeps no history
  }
  /** @param {Line} l */
  function keepLine(l) {
    t.history.push(l);
    if (t.history.length > HISTORY_MAX) {
      const drop = t.history.length - HISTORY_MAX;
      t.history.splice(0, drop);
      t.trimmed += drop;
    }
  }

  function scrollUp(n = 1) {
    for (let i = 0; i < n; i++) {
      const [gone] = t.screen.splice(t.top, 1);
      if (t.top === 0) pushHistory(gone);
      t.screen.splice(t.bottom, 0, blankLine());
    }
    t.screen.forEach(touch);
  }
  function scrollDown(n = 1) {
    for (let i = 0; i < n; i++) {
      t.screen.splice(t.bottom, 1);
      t.screen.splice(t.top, 0, blankLine());
    }
    t.screen.forEach(touch);
  }
  function lineFeed() {
    if (t.y === t.bottom) scrollUp();
    else if (t.y < t.rows - 1) t.y++;
  }

  /** @param {Line} l @param {number} from @param {number} to */
  function erase(l, from, to) {
    for (let x = from; x < Math.min(to, l.cells.length); x++) l.cells[x] = t.key ? { c: ' ', k: t.key } : undefined;
    touch(l);
  }

  /** @param {string} ch */
  function put(ch) {
    if (t.x >= t.cols) {
      t.x = 0;
      lineFeed();
    }
    const l = line();
    l.cells[t.x] = { c: ch, k: t.key };
    touch(l);
    t.x++;
  }

  /** @param {boolean} on */
  function setAlt(on) {
    if (on && !t.main) {
      t.main = { screen: t.screen, x: t.x, y: t.y };
      t.screen = Array.from({ length: t.rows }, blankLine);
      t.x = 0;
      t.y = 0;
    } else if (!on && t.main) {
      ({ screen: t.screen, x: t.x, y: t.y } = t.main);
      t.main = null;
      t.y = fitScreen(t.screen, t.y, t.rows, true);
      t.screen.forEach(touch);
    }
  }

  /** @param {string[]} params */
  function sgr(params) {
    const list = params.length ? params : ['0'];
    for (let i = 0; i < list.length; i++) {
      const [head, ...sub] = list[i].split(':');
      const n = Number(head) || 0;
      // Extended colours come as 38;5;n or 38;2;r;g;b, or with colons (38:2::r:g:b).
      const extended = () => {
        const parts = sub.length ? sub.filter((p, j) => !(sub[0] === '2' && sub.length === 5 && j === 1)) : list.slice(i + 1);
        const mode = Number(parts[0]);
        if (mode === 5) {
          if (!sub.length) i += 2;
          return Number(parts[1]) || 0;
        }
        if (mode === 2) {
          if (!sub.length) i += 4;
          return `rgb(${Number(parts[1]) || 0}, ${Number(parts[2]) || 0}, ${Number(parts[3]) || 0})`;
        }
        return undefined;
      };
      const s = t.style;
      if (n === 0) t.style = s.link ? { link: s.link } : {}; // a link (OSC 8) outlives a colour reset
      else if (n === 1) s.bold = true;
      else if (n === 2) s.dim = true;
      else if (n === 3) s.italic = true;
      else if (n === 4) s.under = sub[0] !== '0';
      else if (n === 7) s.inverse = true;
      else if (n === 9) s.strike = true;
      else if (n === 22) s.bold = s.dim = false;
      else if (n === 23) s.italic = false;
      else if (n === 24) s.under = false;
      else if (n === 27) s.inverse = false;
      else if (n === 29) s.strike = false;
      else if (n >= 30 && n <= 37) s.fg = n - 30;
      else if (n === 38) s.fg = extended();
      else if (n === 39) delete s.fg;
      else if (n >= 40 && n <= 47) s.bg = n - 40;
      else if (n === 48) s.bg = extended();
      else if (n === 49) delete s.bg;
      else if (n >= 90 && n <= 97) s.fg = n - 90 + 8;
      else if (n >= 100 && n <= 107) s.bg = n - 100 + 8;
    }
    t.key = keyOf(t.style);
  }

  /** @param {string} seq */
  function csi(seq) {
    const final = seq.at(-1);
    const prefix = /^[?>=<]/.test(seq) ? seq[0] : '';
    const body = seq.slice(prefix ? 1 : 0, -1).replace(/[ -/]+$/, '');
    const params = body ? body.split(';') : [];
    const n = (i = 0, d = 1) => Number(params[i]?.split(':')[0]) || d;
    if (t.x >= t.cols && final !== 'm') t.x = t.cols - 1;
    if (prefix === '?') {
      if (final === 'h' || final === 'l') {
        const on = final === 'h';
        for (const p of params) {
          if (p === '1') t.appCursor = on;
          else if (p === '25') t.cursor = on;
          else if (p === '2004') t.paste = on;
          else if (p === '1000' || p === '1002' || p === '1003') t.mouse = on;
          else if (p === '1006') t.mouseSgr = on;
          else if (p === '1049' || p === '47' || p === '1047') setAlt(on);
        }
      }
      return;
    }
    if (prefix === '>') {
      if (final === 'c') reply('\x1b[>0;276;0c');
      return;
    }
    switch (final) {
      case 'A': t.y = Math.max(t.y >= t.top ? t.top : 0, t.y - n()); break;
      case 'B': t.y = Math.min(t.y <= t.bottom ? t.bottom : t.rows - 1, t.y + n()); break;
      case 'C': t.x = Math.min(t.cols - 1, t.x + n()); break;
      case 'D': t.x = Math.max(0, t.x - n()); break;
      case 'E': t.y = Math.min(t.rows - 1, t.y + n()); t.x = 0; break;
      case 'F': t.y = Math.max(0, t.y - n()); t.x = 0; break;
      case 'G': case '`': t.x = n() - 1; clampX(); break;
      case 'd': t.y = n() - 1; clampY(); break;
      case 'H': case 'f': t.y = n(0) - 1; t.x = n(1) - 1; clampX(); clampY(); break;
      case 'J': {
        const mode = n(0, 0);
        if (mode === 0) {
          erase(line(), t.x, t.cols);
          for (let y = t.y + 1; y < t.rows; y++) erase(t.screen[y], 0, t.cols);
        } else if (mode === 1) {
          for (let y = 0; y < t.y; y++) erase(t.screen[y], 0, t.cols);
          erase(line(), 0, t.x + 1);
        } else {
          t.screen.forEach((l) => erase(l, 0, t.cols));
          if (mode === 3) {
            t.trimmed += t.history.length;
            t.history = [];
          }
        }
        break;
      }
      case 'K': {
        const mode = n(0, 0);
        erase(line(), mode === 0 ? t.x : 0, mode === 1 ? t.x + 1 : t.cols);
        break;
      }
      case 'L': if (t.y >= t.top && t.y <= t.bottom) { const top = t.top; t.top = t.y; scrollDown(n()); t.top = top; } break;
      case 'M': if (t.y >= t.top && t.y <= t.bottom) { const top = t.top; t.top = t.y; for (let i = 0; i < n(); i++) { t.screen.splice(t.top, 1); t.screen.splice(t.bottom, 0, blankLine()); } t.screen.forEach(touch); t.top = top; } break;
      case 'P': line().cells.splice(t.x, n()); touch(line()); break;
      case '@': line().cells.splice(t.x, 0, ...Array(n())); line().cells.length = Math.min(line().cells.length, t.cols); touch(line()); break;
      case 'X': erase(line(), t.x, t.x + n()); break;
      case 'S': scrollUp(n()); break;
      case 'T': scrollDown(n()); break;
      case 'r': t.top = n(0) - 1; t.bottom = Math.min(t.rows - 1, n(1, t.rows) - 1); if (t.top >= t.bottom) { t.top = 0; t.bottom = t.rows - 1; } t.x = 0; t.y = 0; break;
      case 's': t.saved = { x: t.x, y: t.y, style: { ...t.style } }; break;
      case 'u': if (t.saved) { t.x = t.saved.x; t.y = t.saved.y; t.style = { ...t.saved.style }; t.key = keyOf(t.style); } break;
      case 'm': sgr(params); break;
      case 'n': if (n(0, 0) === 6) reply(`\x1b[${t.y + 1};${Math.min(t.x, t.cols - 1) + 1}R`); else if (n(0, 0) === 5) reply('\x1b[0n'); break;
      case 'c': reply('\x1b[?1;2c'); break;
      default: break;
    }
  }

  /** @param {string} seq */
  function osc(seq) {
    // Programs ask for the background colour to pick a light or dark look.
    const [code, value] = seq.split(';');
    if ((code === '10' || code === '11') && value === '?') {
      const color = background(code === '10' ? 'fg' : 'bg');
      if (color) reply(`\x1b]${code};${color}\x1b\\`);
    }
    // OSC 8 ; params ; uri starts a hyperlink, and an empty uri ends it. Only web links are kept.
    if (code === '8') {
      const uri = seq.slice(seq.indexOf(';', 2) + 1);
      const { link, ...rest } = t.style;
      t.style = /^https?:\/\//i.test(uri) ? { ...rest, link: uri } : rest;
      t.key = keyOf(t.style);
    }
  }

  /** @param {string} ch */
  function escape(ch) {
    t.state = 'text';
    if (ch === '[') {
      t.state = 'csi';
      t.seq = '';
    } else if (ch === ']') {
      t.state = 'osc';
      t.seq = '';
    } else if (ch === 'P' || ch === '_' || ch === '^' || ch === 'X') {
      t.state = 'string';
      t.seq = '';
    } else if ('()*+'.includes(ch)) {
      t.state = 'charset';
    } else if (ch === '7') {
      t.saved = { x: t.x, y: t.y, style: { ...t.style } };
    } else if (ch === '8') {
      if (t.saved) csi('u');
    } else if (ch === 'D') {
      lineFeed();
    } else if (ch === 'E') {
      t.x = 0;
      lineFeed();
    } else if (ch === 'M') {
      if (t.y === t.top) scrollDown();
      else t.y = Math.max(0, t.y - 1);
    } else if (ch === 'c') {
      t.screen = Array.from({ length: t.rows }, blankLine);
      Object.assign(t, { x: 0, y: 0, top: 0, bottom: t.rows - 1, style: {}, key: '', cursor: true, appCursor: false, paste: false });
    }
  }

  /** @param {string} data */
  function write(data) {
    for (const ch of data) {
      switch (t.state) {
        case 'text':
          if (ch === '\x1b') t.state = 'esc';
          else if (ch === '\r') t.x = 0;
          else if (ch === '\n' || ch === '\v' || ch === '\f') lineFeed();
          else if (ch === '\b') t.x = Math.max(0, Math.min(t.x, t.cols) - 1);
          else if (ch === '\t') t.x = Math.min(t.cols - 1, (Math.floor(t.x / TAB) + 1) * TAB);
          else if (ch >= ' ' && ch !== '\x7f') put(ch);
          break;
        case 'esc':
          escape(ch);
          break;
        case 'csi':
          t.seq += ch;
          if (ch >= '@' && ch <= '~') {
            t.state = 'text';
            csi(t.seq);
          } else if (t.seq.length > 64) t.state = 'text';
          break;
        case 'osc':
          if (ch === '\x07' || (ch === '\\' && t.seq.endsWith('\x1b'))) {
            t.state = 'text';
            osc(t.seq.replace(/\x1b$/, ''));
          } else if (t.seq.length < 4096) t.seq += ch;
          break;
        case 'string':
          // DCS, APC and the like carry nothing to show; they end with ESC \ (or BEL).
          if (ch === '\x07' || (ch === '\\' && t.seq === '\x1b')) t.state = 'text';
          t.seq = ch === '\x1b' ? '\x1b' : '';
          break;
        case 'charset':
          t.state = 'text';
          break;
      }
    }
  }

  // A line the board adds itself (the command, how it ended), styled with a class rather than a colour.
  /** @param {string} text @param {string} cls */
  function note(text, cls) {
    // Below everything shown: a program that ended may have left the cursor higher up.
    t.y = Math.max(t.y, used() - 1);
    if (line().cells.some(Boolean)) {
      t.x = 0;
      lineFeed();
    }
    const before = t.style;
    t.style = { cls };
    t.key = keyOf(t.style);
    for (const ch of text) put(ch);
    t.style = before;
    t.key = keyOf(before);
    t.x = 0;
    lineFeed();
  }

  // After a program ends, whatever modes it left on are put back, as a shell would.
  function reset() {
    setAlt(false);
    Object.assign(t, { top: 0, bottom: t.rows - 1, style: {}, key: '', cursor: true, appCursor: false, paste: false, mouse: false, mouseSgr: false, state: 'text' });
  }

  function clear() {
    t.trimmed += t.history.length;
    t.history = [];
    t.screen = Array.from({ length: t.rows }, blankLine);
    t.x = 0;
    t.y = 0;
  }

  // Rows that have shown anything, so a short output does not leave the empty rest of the screen below it.
  function used() {
    if (t.main) return t.rows;
    let last = t.y;
    for (let y = t.rows - 1; y > last; y--) {
      if (t.screen[y].cells.some(Boolean)) {
        last = y;
        break;
      }
    }
    return last + 1;
  }

  // Gives a screen `rows` lines. Lines above the cursor go first (to history, for the main screen), so the cursor
  // stays on screen. Returns the cursor's row.
  /** @param {Line[]} screen @param {number} y @param {number} rows @param {boolean} keep */
  function fitScreen(screen, y, rows, keep) {
    if (screen.length > rows) {
      const fromTop = Math.max(0, Math.min(screen.length - rows, y - rows + 1));
      for (const l of screen.splice(0, fromTop)) if (keep) keepLine(l);
      screen.length = rows;
      y -= fromTop;
    }
    while (screen.length < rows) screen.push(blankLine());
    return Math.min(Math.max(y, 0), rows - 1);
  }

  /** @param {number} cols @param {number} rows */
  function resize(cols, rows) {
    if (cols === t.cols && rows === t.rows) return;
    t.cols = cols;
    // The main screen, put aside while a program (claude) draws on the alternate one, is resized with it: else
    // it comes back with its old number of rows, and drawing or writing past its end throws.
    if (t.main) t.main.y = fitScreen(t.main.screen, t.main.y, rows, true);
    t.y = fitScreen(t.screen, t.y, rows, !t.main);
    t.rows = rows;
    t.top = 0;
    t.bottom = rows - 1;
    clampY();
    t.screen.forEach(touch);
  }

  return Object.assign(t, { write, note, reset, clear, used, resize });
}
