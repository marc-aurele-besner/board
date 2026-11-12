// Finds the JSON in a blob of text: a model's answer with prose around it, a code fence, a terminal's output with
// its long lines wrapped, or a copy cut off at either end. No DOM, so the runners use it too.

// A long output is read from its end, where an answer usually is.
const SCAN = 200000;
// How many shorter cuts a value cut off at the end is tried with before it is given up.
const TAIL_TRIES = 40;

/**
 * @typedef {object} Found
 * @property {unknown} value
 * @property {number} size   length of the text it was read from
 * @property {boolean} [cut] rebuilt from a text cut off at the start or the end
 */

// A terminal wraps a long line with a break and an indent, which JSON does not allow inside a string.
/** @param {string} s */
function parse(s) {
  for (const t of [s, s.replace(/\r?\n[ \t]*/g, ' ')]) {
    try {
      return { value: JSON.parse(t) };
    } catch {}
  }
  return null;
}

// Walks one value from its opening bracket. `end` is its closing bracket; a value cut off at the end of the text
// instead gives the places it could be cut back to (after a comma or a closed bracket inside it), with the brackets
// that would close it there.
/**
 * @param {string} text
 * @param {number} start
 * @returns {{ end: number } | { cuts: Array<{ at: number, closers: string }> } | null}
 */
function walk(text, start) {
  /** @type {string[]} */
  const stack = [];
  /** @type {Array<{ at: number, closers: string }>} */
  const cuts = [];
  const closers = () => stack.slice().reverse().join('');
  let str = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (str) {
      if (c === '\\') i++;
      else if (c === '"') str = false;
    } else if (c === '"') str = true;
    else if (c === '{' || c === '[') stack.push(c === '{' ? '}' : ']');
    else if (c === '}' || c === ']') {
      if (stack.pop() !== c) return null;
      if (!stack.length) return { end: i };
      cuts.push({ at: i + 1, closers: closers() });
    } else if (c === ',') cuts.push({ at: i, closers: closers() });
  }
  return { cuts };
}

// A value cut off at the end, closed after the last part that is whole.
/**
 * @param {string} text
 * @param {number} start
 * @param {Array<{ at: number, closers: string }>} cuts
 */
function closeTail(text, start, cuts) {
  for (const cut of cuts.slice(-TAIL_TRIES).reverse()) {
    const r = parse(text.slice(start, cut.at).replace(/[\s,]*$/, '') + cut.closers);
    if (r) return r;
  }
  return null;
}

// A bare [] or [1] in prose is not data; an object, or a list of objects or of several items, is.
/** @param {unknown} v */
const isData = (v) => v != null && typeof v === 'object' && (!Array.isArray(v) || v.length > 1 || (v.length === 1 && typeof v[0] === 'object'));

/**
 * Every JSON value in the text, in order. A text that is all JSON gives one value. A text cut off at the start keeps
 * the whole items of the list it was in: the items before a stray `]` become that list, and the part of an object
 * cut off before a stray `}` is left out. A text cut off at the end keeps what is whole of its last value.
 * @param {unknown} input
 * @returns {Found[]}
 */
export function findJson(input) {
  const text = String(input ?? '').slice(-SCAN).replace(/⏺/g, ' ');
  const whole = text.trim().replace(/^```[\w-]*\s*\n([\s\S]*?)\n?```$/, '$1').trim();
  if (/^[[{]/.test(whole)) {
    const r = parse(whole);
    if (r) return [{ value: r.value, size: whole.length }];
  }
  /** @type {Array<Found & { from: number }>} */
  let found = [];
  // The values in a row separated only by commas, and where the last one ended: a stray `]` right after them was
  // the end of their list. `since` is where the text after the last stray `}` starts.
  /** @type {Array<Found & { from: number }>} */
  let run = [];
  let runEnd = -1;
  let since = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '{' || c === '[') {
      const w = walk(text, i);
      if (w && 'end' in w) {
        const r = parse(text.slice(i, w.end + 1));
        if (!r) continue;
        const item = { value: r.value, size: w.end + 1 - i, from: i };
        run = run.length && /^[\s,]*$/.test(text.slice(runEnd + 1, i)) ? [...run, item] : [item];
        runEnd = w.end;
        found.push(item);
        i = w.end;
      } else if (w && w.cuts.length) {
        const r = closeTail(text, i, w.cuts);
        if (r) {
          found.push({ value: r.value, size: text.length - i, cut: true, from: i });
          break;
        }
      }
    } else if (c === ']' && run.length && /^\s*$/.test(text.slice(runEnd + 1, i))) {
      // The list these items were in started before the text did.
      const list = { value: run.map((f) => f.value), size: i + 1 - run[0].from, cut: true, from: run[0].from };
      found = [...found.filter((f) => !run.includes(f)), list];
      run = [list];
      runEnd = i;
    } else if (c === '}') {
      // An object that started before the text did: what was found in it is only a part of it. A list rebuilt from
      // a cut-off start is kept, as its items are whole.
      found = found.filter((f) => f.cut || f.from < since);
      run = [];
      since = i + 1;
    }
  }
  return found.filter((f) => f.cut || isData(f.value)).map(({ from, ...f }) => f);
}
