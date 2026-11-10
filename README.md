# Board

A personal command center that runs locally. No backend, no build step, no dependencies: plain HTML, CSS and JavaScript modules. Your data is stored as JSON files in a folder you choose.

Sections (v1):

- **Todos**: personal and per-project lists. Type `buy milk #home` to file a todo under a project. Drag the grip to reorder. Paste several lines to create a todo with a description. Click the description icon to read or edit it.
- **Projects**: quick-add by name, or a detailed form for color, description, and GitHub links (one org, several repos, or none).
- **Kitchen**: recipe ideas, recipes you are testing, and final recipes. Log each iteration with notes and a rating.
- **Money**: rough income and expenses per month, with totals and a per-category breakdown.
- **Tools**: checks on each project's website: is it reachable, when its SSL certificate and domain expire, whether its domain has SPF, DMARC and DKIM records for mail, what its robots.txt, sitemap, llms.txt and security.txt say, and how a shared link to it looks.
- **Notifications**: the bell in the top bar lists deadlines, automated tasks, site checks and Telegram messages.

Tasks have a deadline. The lists **Today**, **To Organize** and **Automated** gather what is due, what arrived without a project or deadline (for example from Telegram), and what the board created by itself. Press Cmd/Ctrl+K or `/` to search, jump, or type a task such as `fix the footer #atlas !high friday`.

## Run it

Browsers only allow the folder picker on a secure origin, so serve the folder locally:

```sh
bunx serve .
# or
python3 -m http.server 8000
```

Then open `http://localhost:<port>` in **Chrome or Edge**. The File System Access API is not available in Firefox or Safari.

`bunx serve` revalidates every file on reload, so the browser always runs the code you just edited. `python3 -m http.server` sends no cache headers, so Chrome reuses the modules it cached earlier and keeps running the old code after a reload: with that server, hard reload the page (Cmd+Shift+R) after every change.

On first launch, choose a data folder. Pick a folder **outside this repo** (for example `~/Documents/board-data`). The app writes `todos.json`, `recipes.json` and `finance.json` there. On later visits, click **Reconnect** once to re-grant permission.

## Data format

Every file has a `schemaVersion` field. Files are plain JSON and can be edited by hand. Reload the page after editing.

| File | Shape |
| --- | --- |
| `projects.json` | `{ projects: [{id, name, color, description, github: {org, repos: ['owner/repo']}, created}] }`. `github.org` and `github.repos` may be empty, for non-coding projects. |
| `todos.json` | `{ items: [{id, text, description, status, priority, category, projectId, due, auto, autoRef, inbox, created}] }`. `projectId: null` means Personal. `due` is a `YYYY-MM-DD` deadline or empty. `auto` names what created the task (`domain`, `ssl`, `health`, `email`, `crawl`, `recurring`, `pools`, `telegram`), and `inbox: true` keeps it in To Organize. Array order is the display order (drag the grip to reorder). |
| `tools.json` | `{ sites: { <projectId>: { health, history, ssl, domain, dns, crawl, meta } }, every }`: the last result of each check, and the minutes between automatic health checks. |
| `notifications.json` | `{ items: [{id, kind, text, href, key, at, read}], prefs: { <kind>: {app, telegram} } }` |
| `recipes.json` | `{ recipes: [{id, title, status: 'idea'\|'testing'\|'final', tags, ingredients, steps, notes, images, versions: [{id, date, changes, rating, notes}], created}] }` |
| `finance.json` | `{ entries: [{id, date, type: 'income'\|'expense', amount, category, note, created}], categories: [], budgets: { <category>: {amount, currency} } }`. A budget is per month and shows in the category breakdown when the period is one month. |

Writes are debounced (about 300 ms) and serialized. The status pill in the top bar shows *Saving…*, *Saved* or *Save failed*.

The currency is set in `js/ui.js` (`CURRENCY`).

## Outside services

Nothing runs on a server, and everything automatic runs only while the board is open. These features talk to other services from your browser, each only when you use or enable it:

| Feature | Service | What is sent |
| --- | --- | --- |
| Website health | the project's own website | a plain request for its home page |
| Domain expiry | `rdap.org` (the registries' lookup protocol) | the domain name |
| SSL expiry | `api.certspotter.com`, then `crt.sh` (public certificate logs) | the host name |
| DNS and email | `cloudflare-dns.com` (DNS over HTTPS) | the domain name, and the `_dmarc` and common DKIM names under it |
| Metadata preview, crawl files, recipe import | `r.jina.ai` (page reader) | the page or file address |
| Telegram | `api.telegram.org` | your bot token, and the messages you exchange with your bot |
| Calendar, Analytics, Search Console | Google, with your own OAuth Client ID | a read-only sign-in that lasts about an hour |
| Bing search data | Bing Webmaster API | your API key. Bing may refuse requests from a browser; the test in Settings says so. |

The typefaces (Inter, Space Grotesk) are in `fonts/`, under the SIL Open Font License, so no font is fetched from another site.

## Project layout

```
index.html            entry point
css/style.css         design tokens (light and dark) and layout
js/app.js             shell: folder connection, router, top nav
js/storage.js         File System Access API wrapper (read/write JSON, remember folder)
js/store.js           in-memory state, debounced saves, subscriptions
js/ui.js              h() DOM helper, ids, dates, money formatting
js/modules/index.js   registry of sections (the nav is built from this list)
js/modules/*.js       one file per section
```

## Adding a section

1. Create `js/modules/<name>.js` with the module contract:

   ```js
   import { h } from '../ui.js';

   export default {
     id: 'books',              // used in the URL hash: #/books
     title: 'Books',           // nav label
     icon: '📚',
     collection: 'books',      // writes books.json in the data folder
     defaults: { items: [] },  // shape used when the file does not exist yet
     render(root, store) {     // fill `root`; call store.update(...) to change data
       const { items } = store.get('books');
       root.replaceChildren(h('h2', null, `${items.length} books`));
     },
   };
   ```

2. Import it and add it to the array in `js/modules/index.js`.

Handlers should call `store.update(collection, mutate)` to save and re-render. Use `store.refresh()` for view-only state such as a filter or tab. Keep view state in a module-level object so it survives re-renders.

## Notes

- Keep the data folder out of git. `.gitignore` already ignores `data/` in case you put it inside the repo.
- Back up the data folder the way you back up any other files (Time Machine, Dropbox, or git inside the data folder).
