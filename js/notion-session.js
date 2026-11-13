// Notion through the browser session (Settings → Notion → Browser session): the token_v2 cookie of notion.so, and
// the API its web app calls (www.notion.so/api/v3). For a workspace where no integration can be added: it reads
// whatever the signed-in account can open. That API is not documented, so every answer is read defensively.
// The runners call it, since a page cannot send Notion's cookie. No DOM here: the worker imports this file.
/** @import { NotionSession } from '../types/data' */
/** @import { NotionPage, NotionProperty, NotionDatabase } from './notion.js' */

const BASE = 'https://www.notion.so/api/v3';
const GAP_MS = 350;

/** @param {number} ms */
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** @param {string} id 32 hex digits, with or without dashes */
export const dashed = (id) => id.replace(/-/g, '').toLowerCase().replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');

let queue = Promise.resolve();
/**
 * One request at a time, a short gap apart.
 * @param {NotionSession} session
 * @param {string} path
 * @param {object} body
 * @returns {Promise<any>} any: each caller reads its own part of the answer
 */
function v3(session, path, body) {
  const run = async () => {
    const token = String(session.tokenV2 ?? '').trim().replace(/^token_v2=/, '');
    if (!token) throw new Error('Paste the token_v2 cookie first.');
    const user = String(session.userId ?? '').trim().replace(/^notion_user_id=/, '');
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetch(BASE + path, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            cookie: `token_v2=${token}${user ? `; notion_user_id=${user}` : ''}`,
            ...(user ? { 'x-notion-active-user-header': user } : {}),
          },
          body: JSON.stringify(body),
        });
      } catch {
        throw new Error('Could not reach Notion. Check the connection.');
      }
      const answer = await res.json().catch(() => null);
      if (res.ok) return answer;
      if (res.status === 429 && attempt < 2) {
        await wait(1000 * (Number(res.headers.get('retry-after')) || 1));
        continue;
      }
      if (res.status === 401 || answer?.name === 'UnauthorizedError') throw new Error('Notion no longer accepts this session. Copy a fresh token_v2 cookie from notion.so.');
      throw new Error(answer?.message || `Notion error ${res.status}`);
    }
  };
  const result = queue.then(run);
  queue = result.catch(() => {}).then(() => wait(GAP_MS));
  return result;
}

// A record in a recordMap. Notion has nested it once ({ value: {...} }) and twice ({ value: { value: {...}, role } }).
/** @param {any} map any: Notion's recordMap @param {string} table @param {string} id @returns {any} */
function record(map, table, id) {
  const r = map?.[table]?.[id]?.value;
  return r?.value && typeof r.value === 'object' && r.value.id ? r.value : r;
}

/** @param {any} map @param {string} table @returns {any[]} */
const records = (map, table) => Object.keys(map?.[table] ?? {}).map((id) => record(map, table, id)).filter(Boolean);

// Rich text as Notion's web app stores it: [["text", [annotations]], ...]. A mention is "‣"; its text is dropped.
/** @param {any} value @returns {string} */
const text = (value) => (Array.isArray(value) ? value : [])
  .map((seg) => (Array.isArray(seg) && typeof seg[0] === 'string' && seg[0] !== '‣' ? seg[0] : ''))
  .join('').trim();

/** @param {any} value @returns {string} */
function dateOf(value) {
  for (const seg of Array.isArray(value) ? value : []) {
    const d = (Array.isArray(seg?.[1]) ? seg[1] : []).find((/** @type {any} */ a) => a?.[0] === 'd')?.[1];
    if (d?.start_date) return String(d.start_date);
  }
  return '';
}

// One property value in the public API's shape, so js/notion.js reads both kinds of page alike.
/** @param {string} type @param {any} value @returns {NotionProperty} */
function property(type, value) {
  const t = text(value);
  if (type === 'title') return { type, title: [{ plain_text: t }] };
  if (type === 'status') return { type, status: t ? { name: t.split(',')[0] } : null };
  if (type === 'select') return { type, select: t ? { name: t.split(',')[0] } : null };
  if (type === 'checkbox') return { type, checkbox: t === 'Yes' };
  if (type === 'date') return { type, date: { start: dateOf(value) } };
  return { type };
}

/**
 * The database a link points to: its collection, a view to query it with, and its space.
 * @param {NotionSession} session
 * @param {string} databaseId
 */
async function locate(session, databaseId) {
  const id = dashed(databaseId);
  const chunk = await v3(session, '/loadPageChunk', { pageId: id, limit: 30, cursor: { stack: [] }, chunkNumber: 0, verticalColumns: false });
  const block = record(chunk?.recordMap, 'block', id);
  if (!block) throw new Error('This Notion account cannot open this database. Check the link, and that you are signed in to its workspace.');
  if (!/^collection_view/.test(block.type ?? '')) throw new Error('This link is a page, not a database. Open the database itself and copy its link.');
  const collectionId = block.collection_id ?? block.format?.collection_pointer?.id;
  const viewId = block.view_ids?.[0];
  const spaceId = block.space_id ?? block.format?.collection_pointer?.spaceId;
  if (!collectionId || !viewId) throw new Error('Notion did not say which collection this database holds.');
  let collection = record(chunk.recordMap, 'collection', collectionId);
  if (!collection) {
    const synced = await v3(session, '/syncRecordValues', { requests: [{ pointer: { table: 'collection', id: collectionId, ...(spaceId ? { spaceId } : {}) }, version: -1 }] });
    collection = record(synced?.recordMap, 'collection', collectionId);
  }
  if (!collection) throw new Error('Notion did not send this database’s properties.');
  /** @type {Record<string, { name?: string, type?: string }>} */
  const schema = collection.schema ?? {};
  return { collectionId, viewId, spaceId, name: text(collection.name), schema };
}

/** @param {Record<string, { name?: string, type?: string }>} schema @returns {Record<string, NotionProperty>} */
const propsOf = (schema) => Object.fromEntries(Object.entries(schema).map(([key, s]) => [s.name ?? key, { type: s.type ?? '' }]));

// The database in the public API's shape: its title and properties.
/** @param {NotionSession} session @param {string} databaseId @returns {Promise<NotionDatabase>} */
export async function sessionDatabase(session, databaseId) {
  const db = await locate(session, databaseId);
  return { title: [{ plain_text: db.name }], properties: propsOf(db.schema) };
}

/**
 * Every page of the database edited since `since` (all without it), oldest edit first, in the public API's shape.
 * The query reads up to 999 pages: the web API has no cursor for it.
 * @param {NotionSession} session
 * @param {string} databaseId
 * @param {string} [since]
 * @returns {Promise<{ database: NotionDatabase, pages: NotionPage[] }>}
 */
export async function sessionPages(session, databaseId, since) {
  const db = await locate(session, databaseId);
  const space = db.spaceId ? { spaceId: db.spaceId } : {};
  const answer = await v3(session, '/queryCollection?src=reset', {
    collection: { id: db.collectionId, ...space },
    collectionView: { id: db.viewId, ...space },
    loader: {
      type: 'reducer',
      reducers: { collection_group_results: { type: 'results', limit: 999 } },
      searchQuery: '',
      userTimeZone: 'UTC',
    },
  });
  /** @type {string[]} */
  const ids = answer?.result?.reducerResults?.collection_group_results?.blockIds ?? [];
  /** @type {NotionPage[]} */
  const pages = [];
  for (const id of ids) {
    const block = record(answer.recordMap, 'block', id);
    if (!block?.last_edited_time) continue;
    const edited = new Date(block.last_edited_time).toISOString();
    if (since && edited < since) continue;
    /** @type {Record<string, NotionProperty>} */
    const properties = {};
    for (const [key, s] of Object.entries(db.schema)) properties[s.name ?? key] = property(s.type ?? '', block.properties?.[key]);
    pages.push({ id: block.id, url: `https://www.notion.so/${block.id.replace(/-/g, '')}`, last_edited_time: edited, archived: block.alive === false, properties });
  }
  pages.sort((a, b) => (a.last_edited_time < b.last_edited_time ? -1 : a.last_edited_time > b.last_edited_time ? 1 : 0));
  return { database: { title: [{ plain_text: db.name }], properties: propsOf(db.schema) }, pages };
}

// Settings' check: who the session is, and its workspaces.
/** @param {NotionSession} session */
export async function checkSession(session) {
  const content = await v3(session, '/loadUserContent', {});
  const users = records(content?.recordMap, 'notion_user');
  const spaces = records(content?.recordMap, 'space').map((s) => s.name).filter(Boolean);
  if (!users.length) throw new Error('Notion did not recognise this session. Copy a fresh token_v2 cookie.');
  const who = users[0].name || users[0].email || 'your account';
  return { text: `Signed in as ${who}${spaces.length ? `, in ${spaces.join(', ')}` : ''}.`, name: users[0].email || users[0].name || '' };
}
