// A page shown in a frame inside the board: a task's artifact page or its PR's preview site (js/task-work.js). Its bar
// shows it at a browser's, a tablet's or a phone's width (a narrower frame, scaled down when the room is smaller), in
// the system's, a light or a dark theme (the frame's color-scheme, which the page reads as prefers-color-scheme), and
// opens its console. A page the board writes into the frame itself sends its console up live, through a script
// added at its top. A site from elsewhere cannot be read by another page, so its console is read by the runners,
// which load it once in headless Chrome at the same size (tools/worker/page-console.js).
/** @import { IconName } from '../types/data' */
import { h, icon } from './ui.js';
import { workerCall } from './runners.js';

/** @typedef {{ level: string, text: string, source?: string }} ConsoleEntry */
/** @typedef {'browser' | 'tablet' | 'mobile'} Device */
/** @typedef {'system' | 'light' | 'dark'} Theme */

/** @type {Record<Device, { label: string, icon: IconName, width: number, height: number }>} */
const DEVICES = {
  browser: { label: 'Browser', icon: 'monitor', width: 0, height: 0 },
  tablet: { label: 'Tablet', icon: 'tablet', width: 768, height: 1024 },
  mobile: { label: 'Phone', icon: 'smartphone', width: 390, height: 844 },
};
const DEVICE_KEY = 'board:preview-device';
/** @type {Record<Theme, string>} */
const THEMES = { system: 'System', light: 'Light', dark: 'Dark' };
const THEME_KEY = 'board:preview-theme';
const ENTRIES_MAX = 500;

// The device every frame shows, remembered in this browser.
/** @type {Device} */
let device = (() => {
  try {
    const d = localStorage.getItem(DEVICE_KEY);
    return d === 'tablet' || d === 'mobile' ? d : 'browser';
  } catch {
    return 'browser';
  }
})();
// The theme every frame shows, remembered in this browser.
/** @type {Theme} */
let theme = (() => {
  try {
    const t = localStorage.getItem(THEME_KEY);
    return t === 'light' || t === 'dark' ? t : 'system';
  } catch {
    return 'system';
  }
})();
let consoleOpen = false;
/** @type {Set<Frame>} */
const live = new Set();

// Sent up by the script a written page gets: its console calls and uncaught errors.
const HOOK = `<script>(()=>{const t=(a)=>{try{return typeof a==='string'?a:a instanceof Error?(a.stack||String(a)):JSON.stringify(a)}catch{return String(a)}};const s=(level,args)=>{try{parent.postMessage({boardConsole:1,level,text:Array.from(args).map(t).join(' ')},'*')}catch{}};for(const l of ['log','info','warn','error','debug']){const o=console[l];console[l]=function(){s(l,arguments);return o.apply(console,arguments)}}addEventListener('error',(e)=>s('error',[e.message+(e.filename?' ('+e.filename+':'+e.lineno+')':'')]));addEventListener('unhandledrejection',(e)=>s('error',['Unhandled rejection: '+t(e.reason)]))})()</script>`;
// It goes right after the page's <head> tag when there is one ahead of its first script, else after its doctype,
// else first. A `<header>`, or a `<head>` in a script's text, is no place for it: its </script> would end that script.
/** @param {string} html */
function withHook(html) {
  const script = html.search(/<script[\s>]/i);
  const head = /<head(?=[\s/>])[^>]*>/i.exec(html);
  const at = head && (script < 0 || head.index < script) ? head.index + head[0].length
    : /^\s*<!doctype[^>]*>/i.exec(html)?.[0].length ?? 0;
  return html.slice(0, at) + HOOK + html.slice(at);
}

addEventListener('message', (e) => {
  const d = e.data;
  if (!d || d.boardConsole !== 1) return;
  for (const f of live) {
    if (f.iframe?.contentWindow === e.source) f.log({ level: d.level === 'warn' ? 'warning' : String(d.level), text: String(d.text).slice(0, 2000) });
  }
});

/**
 * @typedef {{ el: HTMLElement, iframe: HTMLIFrameElement | null, log: (e: ConsoleEntry) => void, layout: () => void, paintBar: () => void }} Frame
 * What to show: a page the board writes (`html`), or a site (`url`); or why it cannot be shown (`refused`, with a link).
 * `check` is a refusal still being worked out: the site loads meanwhile, and gives way to the reason if there is one.
 * @typedef {{ html?: string, url?: string, refused?: string, check?: Promise<string>, sandbox: string, title: string }} FrameContent
 */

/**
 * The frame, its bar (the head's own parts first, then the device and console buttons, then `actions`) and its console.
 * `site` is the address whose console the runners read; without it the console is the written page's own.
 * @param {{ head: (Node | string | null)[], actions: (Node | null)[], load: () => Promise<FrameContent>, site?: string }} options
 * @returns {Frame}
 */
export function previewFrame({ head, actions, load, site = '' }) {
  const stage = h('div', { class: 'preview-stage' }, h('p', { class: 'muted small work-empty' }, 'Loading…'));
  const box = h('div', { class: 'preview-device' });
  const bar = h('span', { class: 'preview-tools' });
  const list = h('div', { class: 'preview-console-list', role: 'log', 'aria-label': 'Console' });
  const status = h('span', { class: 'muted small grow' });
  const consoleEl = h('div', { class: 'preview-console' },
    h('div', { class: 'preview-console-head' },
      h('strong', null, 'Console'),
      status,
      site ? h('button', { type: 'button', class: 'btn-small', title: 'Load the site in headless Chrome at this size and read what it logs', onclick: () => readSite() }, icon('refresh'), 'Read console') : null,
      h('button', { type: 'button', class: 'btn-small', onclick: () => {
        entries.length = 0;
        paintList();
        frame.paintBar();
      } }, 'Clear')),
    list);
  const el = h('div', { class: 'work-preview' }, h('div', { class: 'work-preview-head' }, ...head, bar, ...actions), stage, consoleEl);
  /** @type {ConsoleEntry[]} */
  const entries = [];
  let reading = false;
  let siteRead = '';

  const paintList = () => {
    list.replaceChildren(...(entries.length
      ? entries.map((e) => h('div', { class: `preview-log ${e.level}` },
        h('span', { class: 'preview-log-text' }, e.text),
        e.source ? h('span', { class: 'muted preview-log-source', title: e.source }, e.source.replace(/^https?:\/\/[^/]+/, '')) : null))
      : [h('p', { class: 'muted small work-empty' }, site ? (reading ? '' : siteRead ? 'The site logged nothing.' : 'Nothing read yet.') : 'Nothing logged yet.')]));
    list.scrollTop = list.scrollHeight;
    status.textContent = reading ? 'Loading the site in headless Chrome…' : site && siteRead ? siteRead : '';
  };

  async function readSite() {
    if (reading) return;
    reading = true;
    entries.length = 0;
    paintList();
    const d = DEVICES[device];
    const size = d.width ? { width: d.width, height: d.height, mobile: device === 'mobile' } : { width: 1280, height: 800, mobile: false };
    try {
      /** @type {{ entries: ConsoleEntry[], truncated: boolean, width: number, height: number, ms: number }} */
      const answer = await workerCall('POST', '/page-console', { url: site, ...size, ...(theme === 'system' ? {} : { colorScheme: theme }) }, 60000);
      entries.push(...answer.entries);
      siteRead = `Read at ${answer.width}×${answer.height} for ${answer.ms / 1000} s${answer.truncated ? ', the first ones only' : ''}`;
    } catch (err) {
      entries.push({ level: 'error', text: `Could not read the console: ${/** @type {Error} */ (err).message}` });
      siteRead = '';
    }
    reading = false;
    paintList();
    frame.paintBar();
  }

  /** @type {Frame} */
  const frame = {
    el,
    iframe: null,
    log: (e) => {
      if (entries.length >= ENTRIES_MAX) entries.shift();
      entries.push(e);
      if (consoleOpen) paintList();
      frame.paintBar();
    },
    // The device's width, scaled down to the room there is; the browser fills it. The theme is the frame's color-scheme:
    // "light dark" follows the system's.
    layout: () => {
      box.style.colorScheme = theme === 'system' ? 'light dark' : theme;
      const f = frame.iframe;
      if (!f) return;
      f.style.colorScheme = box.style.colorScheme;
      const d = DEVICES[device];
      stage.classList.toggle('framed', !!d.width);
      if (!d.width) {
        Object.assign(box.style, { width: '', height: '' });
        Object.assign(f.style, { width: '', height: '', transform: '' });
        return;
      }
      const room = Math.max(120, stage.clientWidth - 24);
      const tall = Math.max(120, stage.clientHeight - 16);
      const scale = Math.min(1, room / d.width);
      Object.assign(box.style, { width: `${Math.round(d.width * scale)}px`, height: `${tall}px` });
      Object.assign(f.style, { width: `${d.width}px`, height: `${Math.round(tall / scale)}px`, transform: scale < 1 ? `scale(${scale})` : '' });
    },
    paintBar: () => {
      const errors = entries.filter((e) => e.level === 'error').length;
      const warnings = entries.filter((e) => e.level === 'warning').length;
      bar.replaceChildren(
        h('span', { class: 'preview-devices', role: 'group', 'aria-label': 'Show at' }, /** @type {Device[]} */ (['browser', 'tablet', 'mobile']).map((k) => h('button', {
          type: 'button',
          class: `icon-btn${device === k ? ' on' : ''}`,
          title: DEVICES[k].width ? `${DEVICES[k].label}: ${DEVICES[k].width} px wide` : `${DEVICES[k].label}: the full width`,
          'aria-label': DEVICES[k].label,
          'aria-pressed': String(device === k),
          onclick: () => setDevice(k),
        }, icon(DEVICES[k].icon)))),
        h('select', {
          class: 'preview-theme',
          value: theme,
          title: 'The theme the page is shown in (its prefers-color-scheme)',
          'aria-label': 'Theme',
          /** @param {{ target: HTMLSelectElement }} e */
          onchange: (e) => setTheme(/** @type {Theme} */ (e.target.value)),
        }, /** @type {Theme[]} */ (['system', 'light', 'dark']).map((k) => h('option', { value: k }, THEMES[k]))),
        h('button', {
          type: 'button',
          class: `preview-console-btn${consoleOpen ? ' on' : ''}${errors ? ' errors' : warnings ? ' warnings' : ''}`,
          title: `${consoleOpen ? 'Hide' : 'Show'} the console${site ? ' (read by loading the site in headless Chrome)' : ''}`,
          'aria-pressed': String(consoleOpen),
          onclick: () => {
            consoleOpen = !consoleOpen;
            for (const f of live) f.paintBar();
          },
        }, icon('terminal'), 'Console', entries.length ? h('b', null, String(errors || warnings || entries.length)) : null),
      );
      consoleEl.hidden = !consoleOpen;
      if (consoleOpen) {
        paintList();
        if (site && !siteRead && !reading && !entries.length) readSite();
      }
    },
  };
  live.add(frame);
  new ResizeObserver(() => frame.layout()).observe(stage);
  frame.paintBar();
  /** @param {string} reason @param {string} [url] */
  const refuse = (reason, url) => {
    frame.iframe = null;
    stage.replaceChildren(h('div', { class: 'work-empty work-preview-refused' },
      h('p', { class: 'muted small' }, reason),
      url ? h('a', { class: 'btn-small', href: url, target: '_blank', rel: 'noopener noreferrer' }, icon('globe'), 'Open site') : null));
  };
  load().then((c) => {
    if (c.refused) return refuse(c.refused, c.url);
    const iframe = /** @type {HTMLIFrameElement} */ (h('iframe', { class: 'work-preview-frame', sandbox: c.sandbox, title: c.title, ...(c.html !== undefined ? { srcdoc: withHook(c.html) } : { src: c.url }) }));
    frame.iframe = iframe;
    box.replaceChildren(iframe);
    stage.replaceChildren(box);
    frame.layout();
    c.check?.then((reason) => {
      if (reason && frame.iframe === iframe) refuse(reason, c.url);
    });
  }, (err) => stage.replaceChildren(h('p', { class: 'muted small work-empty' }, /** @type {Error} */ (err).message)));
  return frame;
}

/** @param {Device} d */
function setDevice(d) {
  device = d;
  try {
    localStorage.setItem(DEVICE_KEY, d);
  } catch {}
  for (const f of live) {
    f.layout();
    f.paintBar();
  }
}

/** @param {Theme} t */
function setTheme(t) {
  theme = t;
  try {
    localStorage.setItem(THEME_KEY, t);
  } catch {}
  for (const f of live) {
    f.layout();
    f.paintBar();
  }
}

// Frames no longer shown are let go.
/** @param {Frame} f */
export const dropFrame = (f) => live.delete(f);
