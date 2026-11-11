# Board

A personal command center that runs locally. No backend, no build step, no dependencies: plain HTML, CSS and JavaScript modules. Your data is stored as JSON files in a folder you choose.

Sections (v1):

- **Todos**: personal and per-project lists. Type `buy milk #home` to file a todo under a project. Tasks are sorted by status (in progress first, completed last); click a column title to sort by it, and a third click returns to your own order. Drag the grip to reorder, within a status while sorted by status. Paste several lines to create a todo with a description. Click the description icon to read or edit it.
- **Calendar**: the events of one or more Google accounts side by side, by day, week or month, coloured by calendar, with open task deadlines on their days. Show or hide a calendar with its chip, or filter by project when a calendar has one (Settings → Google Calendar). Open an event for its time, place, notes and a link to Google, or turn it into a task in its calendar's project. Each account signs in on its own for about an hour; events are read for the range on screen and never saved. Home shows the next two days.
- **Projects**: quick-add by name, or a detailed form for color, description, and GitHub links (one org, several repos, or none).
- **Kitchen**: recipe ideas, recipes you are testing, and final recipes. Log each iteration with notes and a rating. Drop a photo of a recipe, handwritten or printed (up to 4 pages), and the model set for Read recipe photos rewrites it as a recipe; the photo is kept in `recipes/` in the data folder.
- **Money**: rough income and expenses per month, with totals and a per-category breakdown.
- **Tools**: checks on each project's website: is it reachable (open a site for its response times, other checks and a log of warnings and errors), when its SSL certificate and domain expire, every DNS record it has (with SPF, DMARC and DKIM for mail), what its crawl files say (robots.txt, sitemap, llms.txt, security.txt, ads.txt, the web app manifest, app links and more, each previewed with a format check), and how a shared link to it looks, with a task for any tag that is missing or could be better. **Provider status** follows the status pages of the services you rely on (GitHub, Vercel, Cloudflare, OpenRouter, and any other Statuspage or Datadog page), with open incidents, maintenance and the last 30 days. **Contracts** reads and writes the smart contracts saved in Settings: every view function can be called with typed inputs (arrays and tuples as JSON) and shows its decoded answer, **Read all** reads the ones without inputs, and every other function is sent as a transaction through your browser wallet once you press **Connect wallet** (nothing asks the wallet before that; with several wallet extensions installed, such as MetaMask, Rabby, Coinbase Wallet or Brave Wallet, pick one from the list), which switches to the contract's chain and asks before signing; the board then waits for it to land.
- **Liquidity Pools** (the **DeFi** tab, with **LP Positions** and **LP Fees Collected** views): Uniswap v3 and v4 positions of the wallets you add in Settings, on Ethereum, Base, Arbitrum One, Optimism, Polygon, BNB Chain, Avalanche, Unichain, Robinhood Chain and ZKsync Era (v3 only, as Uniswap has no v4 there): range, value, unclaimed fees, fee APR and token split, sorted by value, unclaimed fees, fee APR, movement, newest or oldest. In the list view, every column header sorts by that column; click again to flip the order. Fee APR is read over the window picked beside Sort (15 min, 1 h, 3 h, 6 h, 24 h, 7 d or 30 d): every swap in the pool that ended inside the position's range pays it the fee times its share of the liquidity, as a yearly rate of its value. It is an estimate. Public nodes keep about a day of swap history, so the board also saves each position's earnings per hour, and the 7 and 30 day windows fill in as long as the board is opened about once a day. A window that is only partly covered shows the time it covers next to the rate. Where swaps cannot be read, fee APR counts the fees earned since the board first read the position, and shows after an hour. **Movement**, on each card and in the list, is the change in fee APR from the window before the one picked (the 24 h before the last 24 h, for example), in percentage points, shown once both windows are at least half covered. The **⇄** button beside a price range shows it in the pair's other token; the choice is saved per pair and used wherever that pair shows. Click a card, a row or a position in Fees Collected, open or closed, to open its detail: the range on a wider price scale with where the price sits, the room to each edge and the range width; holdings and unclaimed fees per token; fees earned and the fee APR they make over the last 24 h, 7 and 30 days from the saved hours, and per day; its collections; and its wallet, pool, token addresses (with block explorer links), liquidity and collect search. A position whose wallet was removed shows its last saved read. Read-only: only public addresses are used. v4 positions cannot be listed with a call, so the board finds them by searching each wallet's history on the chain, and remembers how far it got. Most public nodes keep only recent history, so set a node that keeps full history, or use **Add position** on the tab: paste a position link from app.uniswap.org (its chain and version are read from the link, for example `/positions/v3/base/556505`), or type its number and pick its chain and version. That also adds a v3 position held by an address that is not in your wallets. Each chain shows as soon as it is read. When a chain cannot be read, its last good read is shown and marked as outdated. Positions your wallets still hold but have emptied (no liquidity, no unclaimed fees) show under the **Closed** filter, left out of the totals. **LP Fees Collected** logs each collection, read from the collect transaction itself: the tokens it paid the wallet, less any liquidity removed in it (for v4, worked out at the pool's price just before), at the token prices of that day. The native coin leaves no token transfer, so its part is what the wallet gained in it, plus the gas it paid, or the amount Etherscan traced. Collects are found three ways, and the surest reading of each is kept: from the node, v3 positions' own events and v4's pool manager events, which read new blocks on every load and walk back toward each position's opening while the node keeps the blocks; and, with an optional Etherscan API key in Settings → Blockchains, each wallet's transactions to the Uniswap position managers, back to its first one. Etherscan only logs positions the board shows, as a burned position no longer says what its tokens are. Between two reads, a drop in a position's unclaimed fees is logged too, as a floor, and gives way to a reading of the same collect from the chain. You can also log a collection by hand or remove one. It shows the total collected, the average per day, week, month and year over all time, 30 days, 90 days or a year, and a chart by day, week or month whose bars show their total, count and top positions on hover, tap or arrow keys. Below the chart: an **Outlook** row (the range against the one before it, month-end and year-end estimates at the last 30 days' pace, the days to the next round total, the time since the last collect with the usual gap, and the average and largest collect); a **running total** with a dashed estimate ahead at the range's pace; the **pace per day** as 7-day and 30-day rolling averages, saying whether fees are speeding up or slowing down; **where fees came from** by position, chain or source, with each one's share; and a calendar of the **last 26 weeks**, one square per day, shaded by the fees collected, with the weekday that brings the most. They follow the chain, token and source filters. The token filter is searchable and shows each token's logo; each position in the log has a dot for open (green in range, amber out of range), closed (grey) or no longer read (hollow). **Search coverage** starts collapsed to a one-line recap and opens to say how sure the log is to hold every collect, for all chains and per chain: the share of positions, open and closed, whose search reached the transaction that opened them, or whose wallet Etherscan has read in full, with partial credit for the blocks searched back so far. Each load searches a step further back; **Search further** beside a chain runs one more step for that chain right away. **AI insights**, above the positions, counts how many are in range, out of range (with the value sitting idle) and near an edge, and with an OpenRouter key asks the model set for Pool insights in Settings to read them: a short summary, then one action per position (keep, watch, re-center, widen, narrow, collect fees or withdraw) with the reason and, where it fits, a suggested range. Prices are read and shown in the base each pair is shown in (see **⇄**). The last 5 reads are saved with their date and time and open again from tabs, and each can be filtered by action, in or out of range, and chain. It reads only the numbers the board shows, and is not financial advice.
- **Wallets** (in the **DeFi** tab): what each wallet in Settings → DeFi wallets holds on the chains Liquidity Pools reads: its native coin and every token on the chain's Uniswap token list, read in a few batched calls through Multicall3, with prices from DefiLlama. Shows the total, the value by token, by chain and by wallet, and a sortable table filtered by wallet and chain. Hide a token from its row; **Tokens** adds a token the list does not carry by its contract address, and lists the added and hidden ones. Each chain shows as soon as it is read; a chain that fails keeps showing its last read. Read-only.
- **Cron**: recurring flows, drawn as a chain of steps like a workflow canvas. A schedule (every few minutes or hours, daily, or weekly) starts the chain: gather data from the board (open tasks, tasks due soon, a project, this month's spending, or fixed text), ask an AI model with a prompt that uses `{{input}}`, then create a task or post a notification. Each step's output from the last run is shown beside it. Flows run only while the board is open; a run missed while it was closed happens once when you open it.
- **Settings**: the gear at the top right. **Blockchains** lists the chains the board reads, with the nodes and block explorers of each, one field per address with a button to add another (built-in chains start with several public nodes and their usual explorer; empty the fields to go back to them), whether Liquidity Pools reads it, and a **Test** that asks each node for its chain ID and latest block and names any that fail. With several nodes, reads go to the node answering fastest, spread across them, and a node that fails or stops answering is set aside for a minute while the others take its calls. Links open in the first explorer listed. Add any other EVM chain by its nodes (its ID is read from them) and, optionally, its block explorers. The optional **Etherscan API key** sits here too: Smart contracts fetches verified ABIs and contract transactions with it, and LP Fees Collected reads each wallet's collects. **Smart contracts** saves contracts by chain, address and ABI (pasted, or fetched from Etherscan when it is verified), optionally tied to a project. **Prompts** shows the system prompt of every AI feature; edit one to change how that feature answers, or add a prompt sent with every AI call.
- **Monitoring**: AI usage (cost, calls and tokens by model and task), GitHub activity, web analytics, search and smart contracts (transactions with an Etherscan key, and the events read from the node, decoded by the ABI, with the methods called, the events emitted and the latest of each). Hover or tap a bar, or focus a chart and use the arrow keys, to read its values. Select a recent AI call to see the messages sent, the full reply and the details OpenRouter returned.
- **Inbox**: the emails every project sends and receives through Resend and Gmail, laid out like a mail client. Received mail lands in the Inbox; Sent, Starred, Archive and All mail are folders beside it. New mail is unread until opened, and the Home page counts it. Star or archive an email (with undo), filter by project, delivery status (delivered, bounced, opened…) and emails that have a task, or search all mail by subject and address. Open an email to read it with the rest of its conversation, or turn it into a task in its project. Each project has its own Resend key in Settings; projects that share an account can share a key, and their emails are told apart by the project website's domain. Needs the relays running, which `bun start` starts (see Outside services). A project can also have one or more Gmail accounts (Settings → Gmail), read-only with the same Google OAuth Client ID as Calendar; each account signs in on its own for about an hour, and a Mailbox filter shows one account at a time.
- **Notifications**: the bell in the top bar lists deadlines, automated tasks, site checks, provider outages and Telegram messages.

Tasks have a deadline. The lists **Today**, **To Organize** and **Automated** gather what is due, what arrived without a project or deadline (for example from Telegram), and what the board created by itself. Press Cmd/Ctrl+K or `/` to search, jump, or capture something:

- a task: `fix the footer #atlas !high friday`
- a Money entry: `-42.50 groceries weekly shop` is an expense, `+4200 salary` is income, both dated today
- a recipe: paste a link to import it into Kitchen

The last row, **See all results**, opens the search on its own page: **All** shows the first matches of each kind, and a tab per kind (Tasks, Projects, Recipes, Sections, Settings) shows every match.

The search box in Tasks filters the list as you type. Words match the title, description, category and project; `#atlas` keeps a project (`#personal` for none), `!high` a priority, `is:doing` a status (`is:done` looks in completed tasks too), `cat:design` a category, and `due:today`, `due:late`, `due:week` or `due:none` a deadline. Search page results for tasks open in Tasks with the same filter.

A task's checkbox selects it; the check button next to its status marks it done. Shift+click selects a range. With tasks selected, a bar sets their status, priority, project, category or deadline at once, copies them as a Markdown checklist, or deletes them. The copy button on a task copies just that one.

Outside a field, `g` then a letter jumps to a section (`g t` for Tasks, `g m` for Money), `n` starts a new task, and `?` lists every shortcut.

Deleting a task, a Money entry, a bill, a recipe or a recipe iteration shows **Undo** for a few seconds.

Settings → Labels lists the task statuses, the task categories, the project labels and the Money categories, each in its own section (the Labels button in Tasks opens it). Rename one, change its colour, drag it into another order (every picker and filter that lists them follows it, and Sort A–Z puts a list back in order), or delete it; deleting one that is in use first moves its tasks, projects, or its entries, recurring items and budget, to another category or label. The seven task statuses are fixed, so they can be renamed, recoloured, reordered and hidden from the pickers, but not deleted.

## Run it

Browsers only allow the folder picker on a secure origin, so serve the folder locally:

```sh
bun start
# or, without Bun
node tools/start.js
```

This starts the board's static server and the local relays for Resend (Inbox) and Bing (search data) together, in one process; Ctrl+C stops them all. Each prints its own lines in the terminal, prefixed with its name (`board`, `bing`, `resend`): the relays log every call (path and status, never the query, which can hold a key) and the board logs page loads and failed requests. Then open `http://localhost:8000` in **Chrome or Edge**. `PORT=<port>` picks another port for the board, and `RESEND_PORT` and `BING_PORT` for the relays (8418 and 8417 by default; set the same address in Settings). To run only one part, use `bun run serve` or `bun run relays`. `package.json` only holds these scripts: there is nothing to install. The File System Access API is not available in Firefox or Safari.

`tools/serve.js` has no dependencies and marks every file `no-cache`, so the browser always runs the code you just edited. Any other static server works too, but `python3 -m http.server` sends no cache headers, so Chrome reuses the modules it cached earlier and keeps running the old code after a reload: with that server, hard reload the page (Cmd+Shift+R) after every change.

On first launch, choose a data folder. Pick a folder **outside this repo** (for example `~/Documents/board-data`). The app writes `todos.json`, `recipes.json` and `finance.json` there. On later visits, click **Reconnect** once to re-grant permission.

To look around first, click **Explore with sample data**. It opens the board on placeholder content kept in memory: nothing is written to disk, the automatic checks stay off, and a reload brings back the folder screen. It also works in Firefox and Safari.

## Data format

Every file has a `schemaVersion` field. Files are plain JSON and can be edited by hand. Reload the page after editing.

| File | Shape |
| --- | --- |
| `projects.json` | `{ projects: [{id, name, color, description, github: {org, repos: ['owner/repo']}, created}] }`. `github.org` and `github.repos` may be empty, for non-coding projects. |
| `todos.json` | `{ items: [{id, text, description, status, priority, category, projectId, due, auto, autoRef, inbox, email, created}], categories: [{id, name, color, scope, projectId, projectCategoryIds}], statuses: { <status>: {name, color, hidden} }, statusOrder: [<status>] }`. `projectId: null` means Personal. `due` is a `YYYY-MM-DD` deadline or empty. `auto` names what created the task (`domain`, `ssl`, `health`, `email`, `crawl`, `recurring`, `pools`, `telegram`, `cron`), `inbox: true` keeps it in To Organize, and `email: {id, dir}` links a task made from an Inbox email. Array order is the display order (drag the grip to reorder). |
| `tools.json` | `{ sites: { <projectId>: { health, history, log, ssl, domain, dns, crawl, meta } }, every, providers: [{id, name, url, kind}], status: { <providerId>: {indicator, description, parts, components, incidents, maintenances, recent, recentCount, kind, at} } }`: the last result of each check, a site's `log` of warnings and errors (`{at, level, source, text}`), the minutes between automatic health and status checks, and the followed status pages. |
| `pools.json` | `{ cache: { "<chainId>:<v3\|v4>": {at, rows} }, prices: { <chainId>: {at, usd} }, scan: { <chainId>: { <wallet>: {node, from, to, span, ids, done} } } }`: the last good read of each chain and version, shown marked as outdated when a read fails; the last token prices; how far each v4 search got; and `fees: { <ref>: {at, f0, f1, v} }`, the unclaimed fees in tokens when the fee counter started (`v` marks a baseline taken since v3 fees are read in full; older v3 baselines start again); and `earned: { <ref>: { <unix hour>: [token0, token1] } }`, what each position earned from swaps per hour, in raw token units as text, for the last 31 days; and `collected: [{id, at, since, source, ref, pair, chain, tokenId, a0, a1, sym0, sym1, usd, note}]`, the fee collections (`source` is `chain`, `etherscan`, `auto` or `manual`; `level` ranks how sure a `chain` or `etherscan` reading is, 1 meaning its native coin part could not be read; `since` is the read before an `auto` one; `tx` is the collect transaction); `history: { <ref>: {node, from, to, span, done, events, checked} }`, how far each position's events were read and what they hold; `etherscan: { <chainId>: { <wallet>: {block, checked} } }`, how far each wallet's Etherscan history was read; and `hidden`, the `<ref>\|<tx>` keys of collections you removed, so they are not read again. `balances: { <chainId>: {at, rows} }` is the Wallets tab's last good read of each chain; `tokens: [{chainId, address, symbol, decimals}]` the tokens added by hand; `hiddenTokens` the `<chainId>:<address>` keys of hidden tokens. Safe to delete except `collected`, `hidden`, `tokens` and `hiddenTokens`, which are not rebuilt; the rest is rebuilt by the next read. |
| `cron.json` | `{ flows: [{id, name, enabled, enabledAt, schedule: {every: 'interval'\|'daily'\|'weekly', minutes, time, weekday}, steps: [{id, type: 'gather'\|'ai'\|'task'\|'notify', ...}], lastRun, created}], runs: [{id, flowId, at, manual, status, error, steps: [{stepId, ok, output, ms}]}] }`. The last 60 runs are kept. |
| `inbox.json` | `{ emails: [{id, projectId, dir: 'sent'\|'received', from, to, cc, subject, at, status, taskId, unread, starred, archived, source, account, msgId}], syncedAt }`: the email list from Resend and Gmail (bodies are read when opened, not saved), up to 1000 per project. `status` is Resend's last event of a sent email. `taskId` is the task made from it. `unread`, `starred` and `archived` are kept on the board only; mail from a key's first read starts as read. Gmail rows have `source: 'gmail'`, the `account` address and Gmail's `msgId`, and keep up to 1000 per account; settings.json lists the accounts as `gmail: { accounts: [{email, projectId}] }`. Safe to delete except for those links. |
| `usage.json` | `{ entries: [{id, at, task, model, promptTokens, completionTokens, cost, input, output, meta, error}] }`: one entry per AI call. `input` is the messages sent (images and files as their type and size only) and `output` the reply; both are kept for the latest 300 calls. `meta` holds the duration, HTTP status, provider, served model, finish reason, generation id and the usage OpenRouter reported. |
| `settings.json` (blockchains) | `blockchains: { custom: [{id, name, rpc, explorer, symbol}], etherscan }`: chains added in Settings → Blockchains, and the Etherscan API key (a key saved before under `uniswap.etherscan` is still read). `rpc`, `node` and `explorer` hold one address or several, separated by spaces. The built-in chains keep their nodes, explorers and Liquidity Pools switch in `uniswap.chains: { <chainId>: {enabled, node, explorer} }`; an empty `node` or `explorer` uses the built-in ones. |
| `settings.json` (contracts) | `contracts: [{id, label, chainId, address, projectId, abi}]`: the contracts Tools and Monitoring read, each with its ABI as JSON. |
| `settings.json` (calendar) | `gcal: { accounts: [{email, calendars: [{id, name, color, on, projectId}]}] }`: the Google accounts Calendar reads and, per calendar, whether it is shown and its project. Events are not saved. |
| `notifications.json` | `{ items: [{id, kind, text, href, key, at, read}], prefs: { <kind>: {app, telegram} } }` |
| `recipes.json` | `{ recipes: [{id, title, status: 'idea'\|'testing'\|'final', tags, ingredients, steps, notes, images, source, scans, versions: [{id, date, changes, rating, notes}], created}] }` |
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
| DNS and email | `cloudflare-dns.com` (DNS over HTTPS) | the domain name, the site's host and `www`, and the `_dmarc`, MTA-STS, TLS reporting, BIMI and common DKIM names under it |
| Provider status | each followed status page (Statuspage's public `/api/v2/summary.json` and `/api/v2/incidents.json`) | nothing but the request itself |
| Metadata preview, crawl files, Datadog status pages, recipe import | `r.jina.ai` (page reader) | the page or file address |
| Cron AI steps | `openrouter.ai`, with your key | the step's prompt, which includes whatever the earlier steps gathered from the board (task titles, a project's description, spending totals) |
| Kitchen recipe photos | `openrouter.ai`, with your key | the dropped photos, shrunk to 1600 px |
| Liquidity Pools AI insights | `openrouter.ai`, with your key | for each open position shown: its pair, chain, fee tier, price range, current price, value, unclaimed fees, fee APR and token split |
| Telegram | `api.telegram.org` | your bot token, and the messages you exchange with your bot |
| Calendar | Google Calendar API (`www.googleapis.com/calendar`), with your own OAuth Client ID | a read-only sign-in per account that lasts about an hour, to list its calendars and read the events of the range on screen |
| Analytics, Search Console | Google, with your own OAuth Client ID | a read-only sign-in that lasts about an hour |
| Liquidity Pools | each chain's node (public nodes by default, or the ones you set; each call goes to one of them) | your wallet addresses and the position numbers |
| DeFi wallets | each chain's node, as above | your wallet addresses and the token addresses checked |
| Blockchains node test | each of the chain's nodes | a request for its chain ID and latest block |
| Smart contracts | the chain's node | the contract address and each call's inputs; for Monitoring, a search of the contract's recent event logs |
| Smart contracts (optional) | `api.etherscan.io`, only with the key set in Settings → Blockchains | the key, and the contract address: to fetch its verified ABI, and its transaction list for Monitoring |
| Smart contract writes | your browser wallet (the extension) | the transaction to sign: the contract, the encoded call and the value; the wallet sends it to the chain |
| Liquidity Pools fee collects (optional) | `api.etherscan.io` (Etherscan), only with a key set in Settings, and not for ZKsync Era, which Etherscan does not cover | your wallet addresses, the key, and the collect transactions and pools it reads |
| Money exchange rates | `api.frankfurter.dev` (ECB rates) by default; `www.bankofcanada.ca` (Valet API) and `cdn.jsdelivr.net` (Currency API) when it fails, or first if picked in Settings → Exchange rates | the days whose USD to CAD rate is needed |
| Liquidity Pools and Wallets prices | `coins.llama.fi` (DefiLlama) | the token addresses in your positions and wallets, and the time of each fee collect read from the chain |
| Liquidity Pools and Wallets logos and token lists | `raw.githubusercontent.com` (Uniswap's token lists, Trust Wallet's chain logos) | nothing but the request itself |
| GitHub organization logos | `github.com` (each `<org>.png` avatar) | the organization or repo owner name |
| Inbox | Resend API, through `tools/relays.js` on your machine (Resend does not answer web pages directly) | each project's Resend API key, to list and read its emails |
| Inbox (Gmail) | Gmail API (`gmail.googleapis.com`), with your own OAuth Client ID | a read-only sign-in per account that lasts about an hour, to list and read its mail |
| Bing search data | Bing Webmaster API, through `tools/relays.js` on your machine (Bing does not answer web pages directly) | your API key and the site address |

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
