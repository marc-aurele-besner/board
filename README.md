# Board

A personal command center that runs locally. No backend, no build step, no dependencies: plain HTML, CSS and JavaScript modules. Your data is stored as JSON files in a folder you choose.

Sections (v1):

- **Todos**: personal and per-project lists. Type `buy milk #home` to file a todo under a project. Drag the grip to reorder. Paste several lines to create a todo with a description. Click the description icon to read or edit it.
- **Projects**: quick-add by name, or a detailed form for color, description, and GitHub links (one org, several repos, or none).
- **Kitchen**: recipe ideas, recipes you are testing, and final recipes. Log each iteration with notes and a rating.
- **Money**: rough income and expenses per month, with totals and a per-category breakdown.
- **Tools**: checks on each project's website: is it reachable, when its SSL certificate and domain expire, whether its domain has SPF, DMARC and DKIM records for mail, what its robots.txt, sitemap, llms.txt and security.txt say, and how a shared link to it looks. **Provider status** follows the status pages of the services you rely on (GitHub, Vercel, Cloudflare, and any other Statuspage page).
- **Liquidity Pools**: Uniswap v3 and v4 positions of the wallets you add in Settings, on Ethereum, Base, Arbitrum One, Optimism, Polygon, BNB Chain, Avalanche, Unichain, Robinhood Chain and ZKsync Era (v3 only, as Uniswap has no v4 there): range, value, unclaimed fees, fee APR and token split, sorted by value, unclaimed fees, fee APR, newest or oldest. In the list view, every column header sorts by that column; click again to flip the order. Fee APR is read over the window picked beside Sort (15 min, 1 h, 3 h, 6 h, 24 h, 7 d or 30 d): every swap in the pool that ended inside the position's range pays it the fee times its share of the liquidity, as a yearly rate of its value. It is an estimate. Public nodes keep about a day of swap history, so the board also saves each position's earnings per hour, and the 7 and 30 day windows fill in as long as the board is opened about once a day. A window that is only partly covered shows the time it covers next to the rate. Where swaps cannot be read, fee APR counts the fees earned since the board first read the position, and shows after an hour. **Movement**, on each card and in the list, is the change in fee APR from the window before the one picked (the 24 h before the last 24 h, for example), in percentage points, shown once both windows are at least half covered. The **⇄** button beside a price range shows it in the pair's other token; the choice is saved per pair and used wherever that pair shows. Click a card, a row or a position in Fees Collected, open or closed, to open its detail: the range on a wider price scale with where the price sits, the room to each edge and the range width; holdings and unclaimed fees per token; fees earned and the fee APR they make over the last 24 h, 7 and 30 days from the saved hours, and per day; its collections; and its wallet, pool, token addresses (with block explorer links), liquidity and collect search. A position whose wallet was removed shows its last saved read. Read-only: only public addresses are used. v4 positions cannot be listed with a call, so the board finds them by searching each wallet's history on the chain, and remembers how far it got. Most public nodes keep only recent history, so set a node that keeps full history, or use **Add position** on the tab: paste a position link from app.uniswap.org (its chain and version are read from the link, for example `/positions/v3/base/556505`), or type its number and pick its chain and version. That also adds a v3 position held by an address that is not in your wallets. Each chain shows as soon as it is read. When a chain cannot be read, its last good read is shown and marked as outdated. Positions your wallets still hold but have emptied (no liquidity, no unclaimed fees) show under the **Closed** filter, left out of the totals. **Fees Collected** logs each collection, read from the collect transaction itself: the tokens it paid the wallet, less any liquidity removed in it (for v4, worked out at the pool's price just before), at the token prices of that day. The native coin leaves no token transfer, so its part is what the wallet gained in it, plus the gas it paid, or the amount Etherscan traced. Collects are found three ways, and the surest reading of each is kept: from the node, v3 positions' own events and v4's pool manager events, which read new blocks on every load and walk back toward each position's opening while the node keeps the blocks; and, with an optional Etherscan API key in Settings, each wallet's transactions to the Uniswap position managers, back to its first one. Etherscan only logs positions the board shows, as a burned position no longer says what its tokens are. Between two reads, a drop in a position's unclaimed fees is logged too, as a floor, and gives way to a reading of the same collect from the chain. You can also log a collection by hand or remove one. It shows the total collected, the average per day, week, month and year over all time, 30 days, 90 days or a year, and a chart by day, week or month whose bars show their total, count and top positions on hover, tap or arrow keys. The token filter is searchable and shows each token's logo; each position in the log has a dot for open (green in range, amber out of range), closed (grey) or no longer read (hollow). **Search coverage** starts collapsed to a one-line recap and opens to say how sure the log is to hold every collect, for all chains and per chain: the share of positions, open and closed, whose search reached the transaction that opened them, or whose wallet Etherscan has read in full, with partial credit for the blocks searched back so far. **AI insights**, above the positions, counts how many are in range, out of range (with the value sitting idle) and near an edge, and with an OpenRouter key asks the model set for Pool insights in Settings to read them: a short summary, then one action per position (keep, watch, re-center, widen, narrow, collect fees or withdraw) with the reason and, where it fits, a suggested range. It reads only the numbers the board shows, and is not financial advice.
- **Cron**: recurring flows, drawn as a chain of steps like a workflow canvas. A schedule (every few minutes or hours, daily, or weekly) starts the chain: gather data from the board (open tasks, tasks due soon, a project, this month's spending, or fixed text), ask an AI model with a prompt that uses `{{input}}`, then create a task or post a notification. Each step's output from the last run is shown beside it. Flows run only while the board is open; a run missed while it was closed happens once when you open it.
- **Settings**: the gear at the top right.
- **Inbox**: the emails every project sends and receives through Resend, laid out like a mail client. Received mail lands in the Inbox; Sent, Starred, Archive and All mail are folders beside it. New mail is unread until opened, and the Home page counts it. Star or archive an email (with undo), filter by project, delivery status (delivered, bounced, opened…) and emails that have a task, or search all mail by subject and address. Open an email to read it with the rest of its conversation, or turn it into a task in its project. Each project has its own Resend key in Settings; projects that share an account can share a key, and their emails are told apart by the project website's domain. Needs `tools/resend-relay.js` running (see Outside services).
- **Notifications**: the bell in the top bar lists deadlines, automated tasks, site checks, provider outages and Telegram messages.

Tasks have a deadline. The lists **Today**, **To Organize** and **Automated** gather what is due, what arrived without a project or deadline (for example from Telegram), and what the board created by itself. Press Cmd/Ctrl+K or `/` to search, jump, or capture something:

- a task: `fix the footer #atlas !high friday`
- a Money entry: `-42.50 groceries weekly shop` is an expense, `+4200 salary` is income, both dated today
- a recipe: paste a link to import it into Kitchen

Outside a field, `g` then a letter jumps to a section (`g t` for Tasks, `g m` for Money), `n` starts a new task, and `?` lists every shortcut.

Deleting a task, a Money entry, a bill, a recipe or a recipe iteration shows **Undo** for a few seconds.

## Run it

Browsers only allow the folder picker on a secure origin, so serve the folder locally:

```sh
bun tools/serve.js
# or
node tools/serve.js
```

Then open `http://localhost:8000` in **Chrome or Edge** (`PORT=<port>` picks another port). The File System Access API is not available in Firefox or Safari.

`tools/serve.js` has no dependencies and marks every file `no-cache`, so the browser always runs the code you just edited. Any other static server works too, but `python3 -m http.server` sends no cache headers, so Chrome reuses the modules it cached earlier and keeps running the old code after a reload: with that server, hard reload the page (Cmd+Shift+R) after every change.

On first launch, choose a data folder. Pick a folder **outside this repo** (for example `~/Documents/board-data`). The app writes `todos.json`, `recipes.json` and `finance.json` there. On later visits, click **Reconnect** once to re-grant permission.

To look around first, click **Explore with sample data**. It opens the board on placeholder content kept in memory: nothing is written to disk, the automatic checks stay off, and a reload brings back the folder screen. It also works in Firefox and Safari.

## Data format

Every file has a `schemaVersion` field. Files are plain JSON and can be edited by hand. Reload the page after editing.

| File | Shape |
| --- | --- |
| `projects.json` | `{ projects: [{id, name, color, description, github: {org, repos: ['owner/repo']}, created}] }`. `github.org` and `github.repos` may be empty, for non-coding projects. |
| `todos.json` | `{ items: [{id, text, description, status, priority, category, projectId, due, auto, autoRef, inbox, email, created}] }`. `projectId: null` means Personal. `due` is a `YYYY-MM-DD` deadline or empty. `auto` names what created the task (`domain`, `ssl`, `health`, `email`, `crawl`, `recurring`, `pools`, `telegram`, `cron`), `inbox: true` keeps it in To Organize, and `email: {id, dir}` links a task made from an Inbox email. Array order is the display order (drag the grip to reorder). |
| `tools.json` | `{ sites: { <projectId>: { health, history, ssl, domain, dns, crawl, meta } }, every, providers: [{id, name, url}], status: { <providerId>: {indicator, description, components, incidents, at} } }`: the last result of each check, the minutes between automatic health and status checks, and the followed status pages. |
| `pools.json` | `{ cache: { "<chainId>:<v3\|v4>": {at, rows} }, prices: { <chainId>: {at, usd} }, scan: { <chainId>: { <wallet>: {node, from, to, span, ids, done} } } }`: the last good read of each chain and version, shown marked as outdated when a read fails; the last token prices; how far each v4 search got; and `fees: { <ref>: {at, f0, f1, v} }`, the unclaimed fees in tokens when the fee counter started (`v` marks a baseline taken since v3 fees are read in full; older v3 baselines start again); and `earned: { <ref>: { <unix hour>: [token0, token1] } }`, what each position earned from swaps per hour, in raw token units as text, for the last 31 days; and `collected: [{id, at, since, source, ref, pair, chain, tokenId, a0, a1, sym0, sym1, usd, note}]`, the fee collections (`source` is `chain`, `etherscan`, `auto` or `manual`; `level` ranks how sure a `chain` or `etherscan` reading is, 1 meaning its native coin part could not be read; `since` is the read before an `auto` one; `tx` is the collect transaction); `history: { <ref>: {node, from, to, span, done, events, checked} }`, how far each position's events were read and what they hold; `etherscan: { <chainId>: { <wallet>: {block, checked} } }`, how far each wallet's Etherscan history was read; and `hidden`, the `<ref>\|<tx>` keys of collections you removed, so they are not read again. Safe to delete except `collected` and `hidden`, which are not rebuilt; the rest is rebuilt by the next read. |
| `cron.json` | `{ flows: [{id, name, enabled, enabledAt, schedule: {every: 'interval'\|'daily'\|'weekly', minutes, time, weekday}, steps: [{id, type: 'gather'\|'ai'\|'task'\|'notify', ...}], lastRun, created}], runs: [{id, flowId, at, manual, status, error, steps: [{stepId, ok, output, ms}]}] }`. The last 60 runs are kept. |
| `inbox.json` | `{ emails: [{id, projectId, dir: 'sent'\|'received', from, to, cc, subject, at, status, taskId, unread, starred, archived}], syncedAt }`: the email list from Resend (bodies are read when opened, not saved), up to 1000 per project. `status` is Resend's last event of a sent email. `taskId` is the task made from it. `unread`, `starred` and `archived` are kept on the board only; mail from a key's first read starts as read. Safe to delete except for those links. |
| `notifications.json` | `{ items: [{id, kind, text, href, key, at, read}], prefs: { <kind>: {app, telegram} } }` |
| `recipes.json` | `{ recipes: [{id, title, status: 'idea'\|'testing'\|'final', tags, ingredients, steps, notes, images, versions: [{id, date, changes, rating, notes}], created}] }` |
| `finance.json` | `{ entries: [{id, date, type: 'income'\|'expense', amount, category, note, created}], categories: [], budgets: { <category>: {amount, currency} } }`. A budget is per month and shows in the category breakdown when the period is one month. A category that goes over is listed on Home and announced once under the bell. |

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
| Provider status | each followed status page (Statuspage's public `/api/v2/summary.json`) | nothing but the request itself |
| Metadata preview, crawl files, recipe import | `r.jina.ai` (page reader) | the page or file address |
| Cron AI steps | `openrouter.ai`, with your key | the step's prompt, which includes whatever the earlier steps gathered from the board (task titles, a project's description, spending totals) |
| Liquidity Pools AI insights | `openrouter.ai`, with your key | for each open position shown: its pair, chain, fee tier, price range, current price, value, unclaimed fees, fee APR and token split |
| Telegram | `api.telegram.org` | your bot token, and the messages you exchange with your bot |
| Calendar, Analytics, Search Console | Google, with your own OAuth Client ID | a read-only sign-in that lasts about an hour |
| Liquidity Pools | each chain's node (a public node by default, or the one you set) | your wallet addresses and the position numbers |
| Liquidity Pools fee collects (optional) | `api.etherscan.io` (Etherscan), only with a key set in Settings, and not for ZKsync Era, which Etherscan does not cover | your wallet addresses, the key, and the collect transactions and pools it reads |
| Liquidity Pools prices | `coins.llama.fi` (DefiLlama) | the token addresses in your positions, and the time of each fee collect read from the chain |
| Liquidity Pools logos | `raw.githubusercontent.com` (Uniswap's token lists, Trust Wallet's chain logos) | nothing but the request itself |
| Inbox | Resend API, through `tools/resend-relay.js` on your machine (Resend does not answer web pages directly) | each project's Resend API key, to list and read its emails |
| Bing search data | Bing Webmaster API, through `tools/bing-relay.js` on your machine (Bing does not answer web pages directly) | your API key and the site address |

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
