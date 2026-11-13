// Tools → Requests: a small Postman. Build an HTTP request, send it, read the answer, and keep it with a project.
// The runners send it, past CORS; with them off the browser sends it, and CORS may block it.
import { h, icon, empty, notice, uid } from '../ui.js';
import { projectTree } from './projects.js';
import { workerCall } from '../runners.js';
import { METHODS, blankRequest, wireOf, sendWire, toCurl, fromCurl } from '../http-request.js';
import { highlight, languageOf } from '../highlight.js';
import { openDialog } from '../modal.js';
import { toast } from '../toast.js';
/** @import { ApiRequest, RequestPair, Store } from '../../types/data' */
/** @import { Wire, WireAnswer } from '../http-request.js' */

/** @typedef {{ busy?: boolean, error?: string, data?: WireAnswer, via?: string }} Answer */

// draft: the request being edited; a saved one's copy, or a new one not in the list yet.
// answers: request id -> its last answer, kept while the page is open.
/** @type {{ draft: ApiRequest | null, part: string, answers: Record<string, Answer>, resTab: string, raw: boolean, wanted: string }} */
const view = { draft: null, part: 'params', answers: {}, resTab: 'body', raw: false, wanted: '' };

const PARTS = [['params', 'Params'], ['headers', 'Headers'], ['body', 'Body'], ['auth', 'Auth']];
const BODY_TYPES = [['none', 'None'], ['json', 'JSON'], ['text', 'Text'], ['form', 'Form']];
// workerCall()'s errors when nothing answers, or when runners started before this route have no POST /http.
const RUNNERS_OFF = /^The runners are not running|^Runners error 404/;

const requestsOf = (/** @type {Store} */ store) => store.get('tools').requests ?? [];
const savedOf = (/** @type {Store} */ store, /** @type {string} */ id) => requestsOf(store).find((r) => r.id === id) ?? null;
const titleOf = (/** @type {ApiRequest} */ r) => r.name.trim() || r.url.trim().replace(/^https?:\/\//, '') || 'Untitled request';
const sizeOf = (/** @type {number} */ n) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/** @param {ApiRequest} r */
function pick(r) {
  view.draft = structuredClone(r);
  view.raw = false;
}

// The draft shown: the one being edited, the one the address asks for, or the first saved request.
/** @param {Store} store */
function draftOf(store) {
  const list = requestsOf(store);
  if (view.wanted) {
    const wanted = list.find((r) => r.id === view.wanted);
    if (wanted) pick(wanted);
    if (wanted || list.length) view.wanted = '';
  }
  if (!view.draft) pick(list[0] ?? blankRequest(uid()));
  return /** @type {ApiRequest} */ (view.draft);
}

/** @param {Store} store */
function save(store) {
  const draft = /** @type {ApiRequest} */ (view.draft);
  const copy = structuredClone(draft);
  store.update('tools', (d) => {
    d.requests ??= [];
    const at = d.requests.findIndex((r) => r.id === copy.id);
    if (at >= 0) d.requests[at] = copy;
    else d.requests.push(copy);
  });
  toast(`Saved ${titleOf(draft)}`);
}

/** @param {Store} store @param {ApiRequest} r */
function remove(store, r) {
  const at = requestsOf(store).findIndex((x) => x.id === r.id);
  view.draft = null;
  if (at < 0) return store.refresh();
  store.update('tools', (d) => {
    d.requests = (d.requests ?? []).filter((x) => x.id !== r.id);
  });
  toast(`Deleted ${titleOf(r)}`, {
    undo: () => store.update('tools', (d) => {
      d.requests ??= [];
      d.requests.splice(Math.min(at, d.requests.length), 0, r);
    }),
  });
}

/** @param {Store} store @param {Answer} answer */
function setAnswer(store, /** @type {string} */ id, answer) {
  view.answers[id] = answer;
  store.refresh();
}

// Sends through the runners; when they are off, from the browser, where a CORS block reads as a failed fetch.
/** @param {Store} store */
async function send(store) {
  const draft = /** @type {ApiRequest} */ (view.draft);
  /** @type {Wire} */
  let wire;
  try {
    wire = wireOf(draft);
  } catch (err) {
    return setAnswer(store, draft.id, { error: /** @type {Error} */ (err).message });
  }
  setAnswer(store, draft.id, { busy: true });
  try {
    const data = /** @type {WireAnswer} */ (await workerCall('POST', '/http', wire, 70000));
    return setAnswer(store, draft.id, { data, via: 'runners' });
  } catch (err) {
    if (!/** @type {Error} */ (err).message.match(RUNNERS_OFF)) return setAnswer(store, draft.id, { error: /** @type {Error} */ (err).message });
  }
  try {
    setAnswer(store, draft.id, { data: await sendWire(wire), via: 'browser' });
  } catch (err) {
    const message = /** @type {Error} */ (err).message;
    setAnswer(store, draft.id, {
      error: err instanceof TypeError
        ? 'The browser could not read the answer: the server is unreachable, or it does not allow requests from other sites (CORS). Start the board with bun start, and the runners send it instead.'
        : message,
    });
  }
}

/** @param {string} text */
async function copy(text, /** @type {string} */ what) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${what} copied`);
  } catch {
    toast('The clipboard is blocked here.');
  }
}

/** @param {Store} store */
function importCurl(store) {
  const dialog = openDialog({
    title: 'Import from cURL',
    wide: true,
    body: h('form', {
      class: 'stack',
      onsubmit: (/** @type {SubmitEvent} */ e) => {
        e.preventDefault();
        const text = String(new FormData(/** @type {HTMLFormElement} */ (e.currentTarget)).get('curl') ?? '');
        try {
          const req = fromCurl(text, uid());
          req.projectId = view.draft?.projectId ?? null;
          view.draft = req;
          view.part = req.bodyType !== 'none' ? 'body' : req.headers.length ? 'headers' : 'params';
          dialog.close();
          store.refresh();
        } catch (err) {
          toast(/** @type {Error} */ (err).message);
        }
      },
    },
      h('label', null, 'cURL command', h('textarea', { name: 'curl', rows: 8, class: 'req-mono', placeholder: "curl https://api.example.com/items -H 'Accept: application/json'", autofocus: true, required: true })),
      h('p', { class: 'muted small' }, 'Opens as a new request. Save it to keep it.'),
      h('div', { class: 'row end' }, h('button', { class: 'primary', type: 'submit' }, 'Import'))),
  });
}

// Rows of key and value, each with a switch to leave it out without losing it.
/** @param {Store} store @param {RequestPair[]} pairs @param {string} label */
function pairsEditor(store, pairs, label) {
  const add = () => {
    pairs.push({ key: '', value: '', on: true });
    store.refresh();
  };
  return h('div', { class: 'stack req-pairs' },
    pairs.length
      ? h('div', { class: 'req-pair-rows' }, pairs.map((p, i) =>
        h('div', { class: 'req-pair' },
          h('input', { type: 'checkbox', checked: p.on !== false, 'aria-label': `Send ${label} ${i + 1}`, onchange: (/** @type {Event} */ e) => (p.on = /** @type {HTMLInputElement} */ (e.target).checked) }),
          h('input', { value: p.key, placeholder: 'Key', 'aria-label': `${label} ${i + 1} key`, autocomplete: 'off', spellcheck: 'false', oninput: (/** @type {Event} */ e) => (p.key = /** @type {HTMLInputElement} */ (e.target).value) }),
          h('input', { value: p.value, placeholder: 'Value', 'aria-label': `${label} ${i + 1} value`, autocomplete: 'off', spellcheck: 'false', oninput: (/** @type {Event} */ e) => (p.value = /** @type {HTMLInputElement} */ (e.target).value) }),
          h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Remove ${label} ${i + 1}`, onclick: () => { pairs.splice(i, 1); store.refresh(); } }, icon('x')))))
      : null,
    h('div', null, h('button', { type: 'button', class: 'btn-small', onclick: add }, icon('plus'), `Add ${label}`)));
}

/** @param {Store} store @param {ApiRequest} r */
function bodyPart(store, r) {
  const noBody = r.method === 'GET' || r.method === 'HEAD';
  const format = () => {
    try {
      r.body = JSON.stringify(JSON.parse(r.body), null, 2);
      store.refresh();
    } catch (err) {
      toast(`Not valid JSON: ${/** @type {Error} */ (err).message}`);
    }
  };
  return h('div', { class: 'stack' },
    h('div', { class: 'chips', role: 'group', 'aria-label': 'Body type' }, BODY_TYPES.map(([k, label]) =>
      h('button', { type: 'button', class: r.bodyType === k ? 'chip active' : 'chip', 'aria-pressed': String(r.bodyType === k), onclick: () => { r.bodyType = k; store.refresh(); } }, label))),
    noBody && r.bodyType !== 'none' ? h('p', { class: 'muted small' }, `${r.method} requests send no body. Pick another method to send it.`) : null,
    r.bodyType === 'json' || r.bodyType === 'text'
      ? h('div', { class: 'stack' },
        h('textarea', {
          class: 'req-mono req-body',
          rows: 10,
          spellcheck: 'false',
          'aria-label': 'Body',
          placeholder: r.bodyType === 'json' ? '{ "name": "value" }' : 'Text to send',
          oninput: (/** @type {Event} */ e) => (r.body = /** @type {HTMLTextAreaElement} */ (e.target).value),
          onkeydown: (/** @type {KeyboardEvent} */ e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              send(store);
            }
          },
        }, r.body),
        r.bodyType === 'json' ? h('div', null, h('button', { type: 'button', class: 'btn-small', onclick: format }, 'Format JSON')) : null)
      : r.bodyType === 'form' ? pairsEditor(store, r.form, 'field') : null);
}

/** @param {Store} store @param {ApiRequest} r */
function authPart(store, r) {
  const a = r.auth;
  const field = (/** @type {'token' | 'user' | 'pass'} */ key, /** @type {string} */ label, type = 'text') =>
    h('label', null, label, h('input', { type, value: a[key] ?? '', autocomplete: 'off', spellcheck: 'false', class: key === 'token' ? 'req-mono' : '', oninput: (/** @type {Event} */ e) => (a[key] = /** @type {HTMLInputElement} */ (e.target).value) }));
  return h('div', { class: 'stack' },
    h('div', { class: 'chips', role: 'group', 'aria-label': 'Auth type' }, [['none', 'None'], ['bearer', 'Bearer token'], ['basic', 'Basic']].map(([k, label]) =>
      h('button', { type: 'button', class: a.type === k ? 'chip active' : 'chip', 'aria-pressed': String(a.type === k), onclick: () => { a.type = k; store.refresh(); } }, label))),
    a.type === 'bearer' ? field('token', 'Token') : null,
    a.type === 'basic' ? h('div', { class: 'row' }, field('user', 'Username'), field('pass', 'Password', 'password')) : null,
    a.type !== 'none' ? h('p', { class: 'muted small' }, 'Sent as the Authorization header, unless Headers sets one. Saved requests keep it in tools.json in your data folder.') : null);
}

/** @param {Store} store @param {ApiRequest} r */
function editor(store, r) {
  const saved = savedOf(store, r.id);
  const projects = projectTree(store.get('projects').projects).map(({ project }) => project);
  const counts = { params: r.params.length, headers: r.headers.length, body: r.bodyType === 'none' ? 0 : 1, auth: r.auth.type === 'none' ? 0 : 1 };
  return h('section', { class: 'card stack req-editor' },
    h('div', { class: 'row req-meta' },
      h('input', { class: 'grow', value: r.name, placeholder: 'Untitled request', 'aria-label': 'Request name', autocomplete: 'off', oninput: (/** @type {Event} */ e) => (r.name = /** @type {HTMLInputElement} */ (e.target).value) }),
      h('select', { 'aria-label': 'Project', onchange: (/** @type {Event} */ e) => { r.projectId = /** @type {HTMLSelectElement} */ (e.target).value || null; } },
        h('option', { value: '' }, 'Personal'),
        projects.map((p) => h('option', { value: p.id, selected: p.id === r.projectId }, p.name))),
      h('button', { type: 'button', class: 'btn-small primary', onclick: () => save(store) }, saved ? 'Save' : 'Save request')),
    h('form', {
      class: 'req-line',
      onsubmit: (/** @type {SubmitEvent} */ e) => {
        e.preventDefault();
        send(store);
      },
    },
      h('select', { class: `req-method m-${r.method.toLowerCase()}`, 'aria-label': 'Method', onchange: (/** @type {Event} */ e) => { r.method = /** @type {HTMLSelectElement} */ (e.target).value; store.refresh(); } },
        METHODS.map((m) => h('option', { value: m, selected: m === r.method }, m))),
      h('input', { class: 'req-mono', value: r.url, placeholder: 'https://api.example.com/items', 'aria-label': 'URL', autocomplete: 'off', spellcheck: 'false', inputmode: 'url', oninput: (/** @type {Event} */ e) => (r.url = /** @type {HTMLInputElement} */ (e.target).value) }),
      h('button', { type: 'submit', class: 'primary', disabled: Boolean(view.answers[r.id]?.busy) }, icon('send'), view.answers[r.id]?.busy ? 'Sending…' : 'Send')),
    h('nav', { class: 'sub-tabs req-parts', role: 'tablist', 'aria-label': 'Request' }, PARTS.map(([k, label]) =>
      h('button', {
        type: 'button',
        role: 'tab',
        class: view.part === k ? 'sub-tab active' : 'sub-tab',
        'aria-selected': String(view.part === k),
        onclick: () => { view.part = k; store.refresh(); },
      }, label, counts[/** @type {keyof typeof counts} */ (k)] ? h('span', { class: 'req-count' }, k === 'body' ? r.bodyType.toUpperCase() : k === 'auth' ? '•' : String(counts[/** @type {keyof typeof counts} */ (k)])) : null))),
    view.part === 'headers' ? pairsEditor(store, r.headers, 'header')
      : view.part === 'body' ? bodyPart(store, r)
        : view.part === 'auth' ? authPart(store, r)
          : h('div', { class: 'stack' }, pairsEditor(store, r.params, 'param'), h('p', { class: 'muted small' }, 'Added to the query the URL may already have.')),
    h('div', { class: 'row req-actions' },
      h('button', { type: 'button', class: 'btn-small', onclick: () => { try { copy(toCurl(r), 'cURL command'); } catch (err) { toast(/** @type {Error} */ (err).message); } } }, icon('copy'), 'Copy as cURL'),
      saved ? h('button', { type: 'button', class: 'btn-small', onclick: () => { view.draft = { ...structuredClone(r), id: uid(), name: r.name ? `${r.name} copy` : '' }; store.refresh(); } }, icon('files'), 'Duplicate') : null,
      h('button', { type: 'button', class: 'btn-small danger', onclick: () => remove(store, r) }, icon('trash'), saved ? 'Delete' : 'Discard')));
}

const toneOf = (/** @type {number} */ status) => (status < 300 ? 'done' : status < 400 ? 'medium' : 'high');

// The body, coloured by its type; JSON is indented unless Raw is on.
/** @param {WireAnswer} data */
function bodyView(data) {
  if (data.binary) return h('p', { class: 'muted small' }, `A ${data.contentType || 'binary'} answer of ${sizeOf(data.size)}. Not shown.`);
  if (!data.body) return h('p', { class: 'muted small' }, 'No body.');
  let text = data.body;
  let lang = languageOf(`x.${/json/i.test(data.contentType) ? 'json' : /html|xml|svg/i.test(data.contentType) ? 'html' : /css/i.test(data.contentType) ? 'css' : /javascript/i.test(data.contentType) ? 'js' : 'txt'}`);
  if (!view.raw && (lang === 'json' || !data.contentType)) {
    try {
      text = JSON.stringify(JSON.parse(text), null, 2);
      lang = 'json';
    } catch {
      // Not JSON after all: shown as it came.
    }
  }
  const lines = highlight(text, lang);
  return h('div', { class: 'code-view req-answer-body', tabindex: '0' },
    h('div', { class: 'code', style: { '--gutter': `${String(lines.length).length + 1}ch` } },
      lines.map((runs, i) => h('div', { class: 'code-line' },
        h('span', { class: 'ln', 'aria-hidden': 'true' }, i + 1),
        h('span', { class: 'lc' }, runs.map(([cls, t]) => (cls ? h('span', { class: `tok-${cls}` }, t) : t)))))));
}

/** @param {Store} store @param {ApiRequest} r */
function answerView(store, r) {
  const a = view.answers[r.id];
  if (!a) return h('section', { class: 'card' }, empty('Send the request to see its answer here. Cmd/Ctrl+Enter in the body sends it too.'));
  if (a.busy) return h('section', { class: 'card' }, h('p', { class: 'muted' }, 'Sending…'));
  if (a.error || !a.data) return notice({ text: a.error ?? 'No answer.' });
  const d = a.data;
  return h('section', { class: 'card stack req-answer' },
    h('header', { class: 'row between' },
      h('div', { class: 'row req-stats' },
        h('span', { class: `pill tone-${toneOf(d.status)}` }, `${d.status} ${d.statusText}`.trim()),
        h('span', { class: 'small' }, `${d.ms.toLocaleString()} ms`),
        h('span', { class: 'small' }, sizeOf(d.size)),
        h('span', { class: 'small muted' }, a.via === 'browser' ? 'sent by the browser' : 'sent by the runners')),
      d.body ? h('button', { type: 'button', class: 'btn-small', onclick: () => copy(d.body, 'Body') }, icon('copy'), 'Copy body') : null),
    d.redirected ? h('p', { class: 'small muted' }, 'Redirected to ', h('code', null, d.url)) : null,
    d.truncated ? h('p', { class: 'small muted' }, `Only the first 2 MB of ${sizeOf(d.size)} are shown.`) : null,
    h('nav', { class: 'sub-tabs', role: 'tablist', 'aria-label': 'Answer' },
      [['body', 'Body'], ['headers', `Headers (${d.headers.length})`]].map(([k, label]) =>
        h('button', { type: 'button', role: 'tab', class: view.resTab === k ? 'sub-tab active' : 'sub-tab', 'aria-selected': String(view.resTab === k), onclick: () => { view.resTab = k; store.refresh(); } }, label)),
      view.resTab === 'body' && d.body && !d.binary
        ? h('label', { class: 'inline small req-raw' }, h('input', { type: 'checkbox', checked: view.raw, onchange: () => { view.raw = !view.raw; store.refresh(); } }), 'Raw')
        : null),
    view.resTab === 'headers'
      ? h('dl', { class: 'req-headers' }, d.headers.flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)]))
      : bodyView(d));
}

// The saved requests, under their project.
/** @param {Store} store @param {ApiRequest} current */
function list(store, current) {
  const requests = requestsOf(store);
  const projects = projectTree(store.get('projects').projects).map(({ project }) => project);
  const groups = [...projects.map((p) => /** @type {[string, string]} */ ([p.id, p.name])), ['', 'Personal']]
    .map(([id, name]) => ({ name, items: requests.filter((r) => (r.projectId ?? '') === id || (id === '' && r.projectId && !projects.some((p) => p.id === r.projectId))) }))
    .filter((g) => g.items.length);
  const open = (/** @type {ApiRequest} */ r) => () => {
    pick(r);
    store.refresh();
  };
  return h('aside', { class: 'card stack req-list' },
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'btn-small primary', onclick: () => { view.draft = { ...blankRequest(uid()), projectId: current.projectId }; view.part = 'params'; store.refresh(); } }, icon('plus'), 'New'),
      h('button', { type: 'button', class: 'btn-small', onclick: () => importCurl(store) }, 'Import cURL')),
    groups.length
      ? groups.map((g) => h('div', { class: 'req-group' },
        h('h4', { class: 'muted small' }, g.name),
        h('ul', { class: 'req-items' }, g.items.map((r) =>
          h('li', null, h('button', { type: 'button', class: r.id === current.id ? 'req-item active' : 'req-item', 'aria-current': r.id === current.id ? 'true' : null, onclick: open(r) },
            h('span', { class: `req-m m-${r.method.toLowerCase()}` }, r.method),
            h('span', { class: 'req-title' }, titleOf(r))))))))
      : h('p', { class: 'muted small' }, 'Saved requests show here, grouped by project.'));
}

/** @param {Store} store */
export function requestsTab(store) {
  const r = draftOf(store);
  return h('div', { class: 'split req-split' },
    list(store, r),
    h('div', { class: 'stack-lg req-main' }, editor(store, r), answerView(store, r)));
}

export const requestsSerialize = () => (view.draft && view.draft.id ? view.draft.id : '');
export const requestsRestore = (/** @type {string | undefined} */ id) => {
  if (id && id !== view.draft?.id) {
    view.wanted = id;
    view.draft = null;
  }
};
