# AGENTS.md

Guidance for any coding agent working in this repository.

## What this is

A personal command center that runs locally. It is plain HTML, CSS and JavaScript ES modules with no backend, no build step and no runtime dependencies. Data lives as JSON files in a folder the user picks through the File System Access API. Read `README.md` for the user-facing description and the data format.

## Run and verify

- Start the board with `bun start` (or `node tools/start.js`): it runs the static server, the command runner and the runners (the worker) together, each logging with its name as prefix. `bun dev` (`tools/dev.js`) runs the same and restarts the static server and the worker when a file they import changes; the command runner runs apart and is never restarted, since a restart stops every command in Dev's terminals (a pull that changes `tools/` would end every claude session). After changing `tools/terminal.js`, restart `bun dev`. `bun run serve` alone serves the folder. Then open `http://localhost:8000` in Chrome or Edge. The File System Access API needs a secure context (`localhost` counts) and does not work in Firefox or Safari.
- A changed module is not always picked up: `python3 -m http.server` sends no cache headers, so the browser reuses the module it cached and keeps running the old code. `tools/serve.js` marks every file `no-cache`, so a reload runs the new code. With the Python server, ask the user for a hard reload (Cmd+Shift+R) before checking a change in the browser.
- Run `bun install` once after cloning. It installs TypeScript as a dev-only tool (it never ships to the browser) and turns on `.githooks/pre-commit`.
- Syntax check every module before committing:
  `for f in js/*.js js/modules/*.js tools/*.js tools/*/*.js; do node --experimental-default-type=module --check "$f" || echo "FAIL $f"; done`
- Type check with `bun run typecheck`. `tools/typecheck.js` runs `tsc` over the JSDoc with two configs: `jsconfig.json` for the browser code (`js/`, `types/`) and `tools/jsconfig.json` for the Node runner, which sees neither `window` nor `document`. The runner's modules from `js/` are checked by the browser config, so only errors in `tools/` count in the second run. Every `.js` file is checked in strict mode, with no opt-in: a new file is checked as soon as it exists. `bun run check` runs the syntax loop, the import, merge, Dev session task, LinkedIn queue and app version checks and the type check together; the pre-commit hook runs it.
- The worker imports modules from `js/` under Node, so those must not touch `document`, `window`, `localStorage` or `location` when they load, nor import a module that does. `node tools/check-imports.js` loads every job and catches both a missing import and a DOM call at load time. `node tools/check-merge.js` checks that the worker's writes and a tab's merge without losing either.
- Test real behavior in the browser when you can. Folder picking needs a user click, so ask the user to drive that step if you cannot.

## Layout

```
index.html            entry point; inline script applies the saved theme before paint
manifest.webmanifest  the installed app (Chrome's Install): icons in icons/ (PNGs rendered from the SVGs), Dock shortcuts, launch_handler focus-existing; no service worker
oauth.html            where Google's, Notion's and LinkedIn's sign-ins come back; hands the code to the board's tab
css/style.css         design tokens (light and dark) and all styles
js/app.js             shell: folder connection, router, top nav, theme toggle
js/storage.js         File System Access API wrapper; remembers the folder in IndexedDB
js/store.js           in-memory state; debounced, serialized saves merged with what other tabs saved; disk sync; subscriptions
js/merge.js           three-way merge of a collection (last read, this tab, on disk), item by item by id
js/keep-fields.js     keeps unsubmitted fields across re-renders; holds background re-renders while typing
js/app-version.js     asks GET /version, offers a reload when the files changed, forces one on a new APP_EPOCH; carries typed fields and scroll over
js/app-version-core.js  APP_EPOCH and the rules: current, reload offered or required, snooze, quiet reload, loop guard (no DOM)
js/ui.js              h() DOM helper, icon(), ids, dates, money formatting
js/menu.js            context menus with submenus: on a right click, or under a ⋯ button
js/hover-tip.js       the quick, styled tooltip of the controls inside a container (Dev's terminal bar), from their title
js/modules/index.js   registry of sections (the nav is built from this list)
js/modules/*.js       one file per section (todos, projects, kitchen, money, tools, ...)
js/notifications.js   the bell and its drawer
js/attention.js       the number pills on the nav tabs, and their total as the installed app's Dock badge: Slack mentions and Dev claude terminals waiting on the user (a question, or a turn ended without the done signal), read every 20 s; unread LinkedIn comments on Inbox
js/notify-core.js     notify(), the kinds and their preferences, the deadline check; saved in notifications.json (no DOM)
js/money-core.js      budgets gone over and recurring due dates (no DOM)
js/projects-core.js   a project's shape, and createProject() from a #tag (no DOM)
js/automations.js     site checks and the rules that turn their results into tasks
js/terminal.js        Dev's calls to the command runner: info, folders and files, a command's streamed output, keys, git
js/folder-picker.js   the dialog that finds a folder on this machine through the runner (Projects → Local folder)
js/vt.js              the terminal emulator Dev draws command output with (cursor moves, colours, alternate screen)
js/highlight.js       syntax colours for the Dev file reader, per language, with no dependency
js/sitecheck.js       the lookups behind Tools (health, domain, certificate, share tags)
js/notion.js          Notion databases into tasks: integration secret or OAuth token at api.notion.com, or the browser session
js/notion-session.js  Notion through the token_v2 cookie and notion.so's own web API, answers in the public API's shape (no DOM)
js/telegram.js        tasks from Telegram messages, read by the runners; setup's Find my chat
js/ai.js              the one OpenRouter call; logs each call's input, output and details to usage.json
js/prompts.js         the system prompt of every AI feature; Settings → Prompts overrides them
js/profile.js         a project's saved profile: reads its folder, commits, repos and pages, asks the model once, saves it on the project
js/brand.js           a project's brand (images, colours, fonts, links): reads its folder and site's head tags, asks the model, adds what is new
js/modules/project-brand.js  the Brand block of a project's page: swatches, images, fonts, links, editing and Find with AI
js/modules/project-linkedin.js  the LinkedIn block of a project's page: its posts as Drafts, Scheduled and Posted with their latest results, New post
js/contacts-core.js   contacts.json without the DOM: addContacts() (merged by LinkedIn handle or address), findByEmail(), contactsOf()
js/modules/project-contacts.js  a project's Contacts block, Projects → Contacts, the contact dialog, Inbox's contact chip, Calendar's guests
js/chart.js           SVG bar and line charts with a hover tooltip
js/socials.js         the X, LinkedIn, GitHub and Instagram accounts, their follower (and GitHub star) history in socials.json; parsing a handle or profile link (no DOM)
js/linkedin-core.js   linkedin.json without the DOM: the official sign-in's code trade and expiry notice, a task's draft, posting through the API
js/linkedin.js        LinkedIn's official sign-in popup (Settings → LinkedIn → Publish as you), and Post now through the runners
js/linkedin-composer.js  the LinkedIn post composer: text, link, a feed preview, Save draft, Schedule and Post now
js/linkedin-reads.js  the session reads of posts (UNVERIFIED voyager paths and their defensive parsing): when each post's results are due (1 h, 24 h, 7 d), and its comments
js/linkedin-search.js  Cron's LinkedIn reads through the session (UNVERIFIED voyager paths, defensive parsing): a company by name, its people, a profile
js/linkedin-session.js  linkedinCall(store, req): the one entry point for any LinkedIn read through the saved session (contract at its top); the runners run the queue, a tab asks them (no DOM)
js/modules/settings-socials.js  Settings → X / Twitter, LinkedIn, GitHub and Instagram accounts: accounts, their projects, LinkedIn’s session, its state, calls today and daily limit; Read now
js/modules/monitoring-socials.js  Monitoring → Socials (X, LinkedIn, GitHub, Instagram): followers (and GitHub stars) now, growth over the period, a line per account, Read now
js/modules/monitoring-linkedin-posts.js  Monitoring → Socials, LinkedIn: post marks on an account's follower line and the posts table with their results, Read results now
js/modules/inbox-linkedin.js  Inbox → LinkedIn: comments on the member's posts, Mark read, Make task, Draft reply with AI (copied, never posted)
js/modules/monitoring-ai.js  Monitoring → AI usage overview: board calls and Dev sessions by source and project, a chart and table broken down by project, source, model or feature, against the period before
js/modules/monitoring-dev.js  Monitoring → AI usage → Dev sessions: a chart and table by project, model, effort or billing, in cost, tokens, time or sessions
js/modules/monitoring-tools.js  Monitoring → AI usage → Skills and MCP: the skills Dev sessions ran and the MCP tools they called, each counted on its own
js/modules/monitoring-development.js  Monitoring → Development: the Dev sessions' claude turns (usage.json `dev` turns) in four views under one project filter; Overview (summary against the period before, insights, time, projects, hours) and Turns (lengths, tasks, a log of recent turns)
js/modules/monitoring-development-tools.js  Monitoring → Development → Skills & MCP and Tools: each skill, MCP tool or server, and every tool, with its calls, turns, failures and time per call
js/dev-turns.js       Development's numbers without the DOM: a turn's working and review time, its tools grouped and added up, and the findings of the Insights card; toolRows() also feeds the tools button on Dev's bar, sessionSkills() and sessionMcp() its skills and MCP buttons
js/chains.js          every chain the board reads: the built-in ones and those added in Settings → Blockchains
js/abi.js             Solidity ABI encoding and decoding: calls, answers and event logs
js/contracts.js       saved smart contracts: reads through the node, writes through the browser wallet, activity
js/pool-insights.js   the Liquidity Pools AI insights: in and out of range positions, and what to adjust
js/multicall.js       Multicall3: many read-only calls in one request
js/balances.js        native and token balances of the DeFi wallets (DeFi → Wallets)
js/aave.js            Aave v3 supply, debt and health factor of the DeFi wallets (DeFi → Lending / Borrowing)
js/resend.js          the Inbox's Resend reads: email lists per project key (runners), and one email's body (asked of the runners)
js/google.js          every Google sign-in, kept in google.json; the sign-in popup and account pictures
js/google-core.js     Google tokens without the DOM: live access tokens, googleFetch; only the runners renew a token
js/npm.js             a project's npm org and packages: the runners' registry reads into npm.json, and the board's asks for missing ones
js/gmail.js           the Inbox's Gmail reads: one sign-in per account, its email list, and one email's body
js/gcal.js            Calendar's Google reads: one sign-in per account, its calendar list; events read by the runners into calendar.json
js/slack.js           the Slack tab's Web API calls through the runners (browser session token and d cookie): workspaces, channels, people, counts, messages, threads, reactions
js/slack-markup.js    Slack's mrkdwn (mentions, links, code, quotes, emoji) as DOM nodes
js/emoji.js           Slack's emoji short names, categories and skin tones, from js/emoji-data.js (generated from emoji-datasource)
js/emoji-picker.js    the emoji picker, laid out like Slack's: search, category tabs, preview, skin tone; frequently used (by use and recency) also feeds Slack's quick reactions
js/modules/slack.js   Slack: every workspace in one sidebar with groups, order, mutes and projects; messages, threads and reactions read live
js/runner-jobs.js     the jobs the runners do, with their labels and default intervals (shared by the worker and Settings)
js/runners.js         the board's side of the runners: their heartbeat in runners.json, Run now, their data folder's path
js/modules/monitoring-runners.js  Monitoring → Board runners: the static server, command runner and worker, and every job's last outcome
js/modules/settings-runners.js  Settings → Runners: the worker's status and folder, and each job's switch, interval and Run now
js/task-links.js      a task's GitHub issues and PRs; finds the links a Dev session prints and adds them to its tasks
js/task-work.js       a task row's work pill (PRs, issues, previews, Dev sessions, artifacts) and its popover, with the session's live terminal
js/project-work.js    the project pill in Tasks' header (overview, site, repos, local files, Dev sessions), painted into task-work.js's popover
js/link-states.js     whether a task's issues and PRs are open, merged or closed: read by the runners into github.json, coloured on tasks
js/previews.js        the Vercel and Netlify preview links in PR comments: read by the runners into github.json, shown on tasks and Cron runs
js/deployments.js     a PR's deployments from the Vercel and Netlify APIs (with Settings' tokens), and their build logs (no DOM)
js/deploy-panel.js    a preview's panel: state, commit, timings, error, links and its build log, reloaded while it builds
js/images.js          which pasted or dropped files are images claude reads
js/task-images.js     a task's images: kept in the data folder, shown on the task, saved through the runner for claude
js/task-worktrees.js  the worktrees Dev sessions made for tasks; removed through the runner once their tasks are done, their terminals closed
js/modules/dev-agent-field.js  a project's agent pick (or its own command), shared by Settings → Coding Agents and a project's page; agents' logos
js/modules/dev-worktrees.js  Dev's Worktrees panel: the repo's worktrees, whether each is in use, and removing them
js/modules/dev-uses.js  the skills and MCP panels of Dev's bar: a session's skills (what each does, its turns) and its MCP calls by server and tool (failures, time per call)
js/modules/dev-pr.js   Dev's pull request view: the branch against the default branch, file list, diffs as cards that fold, Viewed marks
js/dev-usage.js       what a task's claude session used (model, effort, tokens, cost), kept in usage.json `dev`
js/dev-done.js        claude's done signal: the line a task prompt asks for, and whether a reply ends with it (Dev's turns)
js/dev-core.js        Dev without the DOM: runner address, presets, a project's Dev command, starting a terminal on the runner
js/models.js          the model an AI task uses (Settings → Models & tasks)
js/defi/positions-read.js  Liquidity Pools reads without the DOM: positions, fee APR, collects; all saved in pools.json; openPositions() for Cron and Home
js/defi/wallets-read.js  DeFi → Wallets balances read per chain into pools.json balances
js/defi/lending-read.js  DeFi → Lending Aave accounts read per chain into pools.json lending
js/json-extract.js    findJson(): the JSON in a blob of text (prose, fences, wrapped lines, cut off at either end) for Cron's Parse JSON step
js/meetings.js        upcoming meetings with guests, each guest matched to contacts with their latest emails: Cron's meetings source (no DOM)
js/capture.js         parseTask(), parseMoney() and makeTask(): one place for a task's shape
js/task-tree.js       the tree parentId makes: wouldLoop() and descendantsOf() (no DOM)
js/palette.js         the Cmd/Ctrl+K search palette: jump, or capture a task, a Money entry or a recipe link
js/search.js          what the full search page (modules/search.js, hidden) looks through, grouped by kind
js/settings-pages.js  the Settings pages by category (the rail, the lists, search and the palette), keyed by their ?section= (no DOM)
js/locale.js          Appearance's date, time, number and week choices: dateLocale(), numberLocale() and weekStart(), which every date and number shown goes through (no DOM at load)
js/appearance.js      Appearance's look and navigation choices in this browser: applyAppearance(), the start page, hidden top-bar sections, how links open, whether removals ask
js/remove.js          removeWithUndo(): a removal from the board's data asks first, or happens at once with Undo
js/modules/settings-appearance.js  Settings → Appearance
js/command-field.js   a shell command in an editor's colours, and its field: {{variable}} chips, Edit and Preview (Settings → Coding Agents)
js/slash-complete.js  the list of Claude Code skills a "/" opens under the caret of a task's description: narrowing, arrows, Enter or Tab
js/task-query.js      the Tasks search: words plus #project, !priority, is:status, cat: and due: filters
js/shortcuts.js       the single-key shortcuts ("g" then a letter) and the sheet that lists them
js/sample.js          "Explore with sample data": a data folder in memory with placeholder content
fonts/                bundled typefaces (SIL Open Font License)
package.json          scripts (start, dev, serve, terminal, typecheck, check); no runtime dependencies, only TypeScript as a dev tool
jsconfig.json         the type check of the browser code (tools/jsconfig.json checks the Node runner)
types/                .d.ts files: browser APIs missing from lib.dom, and the shared data model
.githooks/pre-commit  runs bun run check before each commit
tools/start.js        one command for the board: starts serve.js, terminal.js and worker.js together
tools/dev.js          bun dev: the command runner unwatched, the rest of start.js under bun --watch
tools/log.js          terminal lines prefixed with each runner's name
tools/serve.js        local static server with no-cache headers; GET /version fingerprints the page's files for open tabs; no dependencies
tools/slack.js        POST /slack and /slack/file: Slack calls from Node, which can send the session's d cookie
tools/terminal.js     the Dev section's runner: terminal sessions that outlive the page (output and the list of open terminals kept on disk), typed keys, read-only file reads, git for Source control, listing worktrees and removing one (a done task's, or any from Dev's Worktrees panel), ending a done claude with /exit and answering its worktree question, saving images for claude, showing a path in Finder, each terminal's token for the board's tasks (POST /scope) and the other terminals on the same tasks (POST /scope/peers); localhost only
tools/worker.js       the runners: one worker that runs the background jobs on a schedule and writes into the data folder; localhost API on 8420
tools/worker/store.js the store for Node (get, update, save over node:fs), merged with what the tabs write through js/merge.js
tools/worker/schedule.js  intervals, no overlap, timeouts, backoff, and the runners.json heartbeat
tools/board.js        `node "$BOARD_CLI" task list|show|add|edit|sessions`, `session`, `project`, `brand`, `image list|get|add`: a Dev session's own tasks and their context from inside its terminal, through the runners (BOARD_API, BOARD_SESSION_TOKEN)
tools/board-skill.js  the board-tasks skill's link in ~/.claude/skills: its state and installing it (Settings → Coding Agents through the command runner, and tools/install-skill.js for `bun run install-skill`)
skills/board-tasks/SKILL.md  the skill that tells claude how to use tools/board.js
tools/worker/tasks.js  a Dev session's own tasks (POST /tasks/list, show, add, edit) by its terminal's token: its roots read-only, what is under them and what it made; 100 per session
tools/worker/context.js  what else a Dev session reads by its token: the other terminals on its tasks (POST /sessions/peers), its tasks' project and brand (POST /project, /project/brand), their images (POST /images/list, /images/add: image types only, 5 MB)
tools/worker/http.js  the worker's localhost API: status, Run now, data folder
tools/jobs/*.js       one file per job: { id, timeout, delay, setup(store), run(ctx) }; listed in tools/jobs/index.js
tools/jobs/gmail.js, resend.js  read new mail into inbox.json; resend.js also answers GET /resend/email/<id> and POST /resend/check
tools/jobs/calendar.js  reads every shown calendar's window into calendar.json, or a range Calendar asks for
tools/jobs/monitoring.js  deadlines, budgets, site checks, status pages and the rules that make tasks, every 5 minutes
tools/jobs/telegram.js  long-polls the bot and turns messages into tasks (a `loop` job: it starts again at once)
tools/jobs/github.js, npm.js, webstats.js, fx.js  GitHub counts (github.json), npm packages (npm.json), Bing data (webstats.json), exchange rates (fx.json)
tools/jobs/socials.js  reads X and LinkedIn follower counts from the profile pages (LinkedIn company pages with the saved session), GitHub followers and stars from its API, Instagram's from the link-preview page
tools/jobs/linkedin-metrics.js  reads posts' results (reactions, comments, reposts, impressions) at 1 h, 24 h and 7 d through the session queue, a few calls a run
tools/jobs/linkedin-comments.js  reads new comments on the posts of the last 14 days every 2 hours through the session queue, one call per post; notifies a new batch
tools/jobs/dev-usage.js, worktrees.js  what claude sessions used; removing done tasks' worktrees through the command runner
tools/jobs/defi.js    the DeFi jobs (positions, fee history, wallets, lending, hourly snapshots), run one at a time
tools/jobs/cron.js    starts due Cron flows every minute, and one flow on Run now
tools/jobs/linkedin-posts.js  posts the scheduled LinkedIn posts when due, every minute; more than 12 h late they are marked missed
tools/jobs/link-states.js  reads the states of tasks' issues and PRs every 2 minutes
tools/jobs/previews.js  reads the preview links of open tasks' and recent Cron runs' PRs every 2 minutes
tools/jobs/google.js  renews Google access tokens; a tab that finds one expired asks it through POST /run/google
tools/check-imports.js  loads every worker module under plain Node, to catch a missing import or a DOM call at load time
tools/check-merge.js  the worker and a tab change two fields of one file; both must survive
tools/check-board-tasks.js  a Dev session's tasks: what it may read and change, the limit, a tab's write meanwhile; its project, brand, images and peers
tools/linkedin-session.js  the LinkedIn session's queue (runners only): 20–40 s gap, daily limit, cache in linkedin.json, stop on sign-out; POST /linkedin/voyager runs it for a tab
tools/check-linkedin.js  the LinkedIn queue against a stubbed fetch: gap, limit, cache, sign-out
tools/check-app-version.js  the app version rules: when a tab is current, offered a reload or made to reload
tools/usage.js        reads Claude Code's transcripts for the runner: a task worktree's models, tokens, cost and effort, and each turn's tools (calls, failures, time), skills and output tokens
```

## Conventions

- **No framework and no new dependencies.** Build DOM with `h()` from `js/ui.js`. Use `innerHTML` only inside `icon()`, which takes trusted static markup.
- **Icons, not emoji.** Add a path to `ICON_PATHS` in `js/ui.js` and refer to it by name. Module `icon` fields are icon names.
- **Module contract.** A section exports `{ id, title, icon, collection, defaults, render(root, store) }`. `render` fills `root`. Add the section to `js/modules/index.js`.
- **Data changes go through the store.** Call `store.update(collection, mutate)` to save and re-render. Call `store.refresh()` for view-only state such as filters and tabs. Keep view state in a module-level object so it survives re-renders.
- **Re-rendering replaces the DOM.** Do not re-render on every keystroke in a field the user is typing in, or focus is lost. Update only the affected list, as the kitchen search does.
- **New tasks.** Create a task with `makeTask()` from `js/capture.js`, so every task has the same fields. A task the board makes by itself sets `auto` and `autoRef`.
- **AI prompts.** A new AI feature adds its system prompt to `PROMPTS` in `js/prompts.js` and reads it with `systemPrompt(store, id, vars)`, so it can be edited in Settings.
- **Outside services.** A new lookup that leaves the browser is listed in the README under "Outside services", with what it sends.
- **LinkedIn's session.** Every call with the saved `li_at` / `JSESSIONID` goes through `linkedinCall()` in `js/linkedin-session.js` (or `voyager()` in `tools/linkedin-session.js` from a job), never a `fetch` of its own: the queue keeps the pace, the daily limit and the stop after a sign-out. Give each repeatable read a `cacheKey`. Never test with the real session; stub `fetch` as `tools/check-linkedin.js` does.
- **Cross-section data.** A section may read another section's collection through the store (todos read projects). Write to the other collection with its own `store.update` call.
- **Old tabs.** An open tab learns from `GET /version` that the files changed and offers a reload. When a change must not meet a tab still running the old code (a data file's new shape that an old tab would save back in its old one), bump `APP_EPOCH` in `js/app-version-core.js` in the same commit: every older tab then reloads by itself.
- **Typed data.** Each JSON file's shape is in `types/data/<name>.d.ts`, collected in `Collections` in `types/data.d.ts`, so `store.get('todos')` is typed in every file. To add a field: add it to the interface (optional, `field?: T`, since older files lack it), add it to the matching `types/fixtures/<name>.json`, then run `bun run typecheck`; every file that is checked and misuses the field fails. A new collection needs its own `.d.ts`, an entry in `Collections` (and `WorkerCollections` if only the runners write it), a fixture and a line in `types/fixtures.check.js`. Stored enum-like fields stay `string`; narrow them in code.
- **JSDoc types.** Annotate exported functions and their parameters, and let inference do the rest. Import shared shapes with `/** @import { Task, Store } from '../types/data' */`. No `@ts-ignore`; an `any` or `@ts-expect-error` carries its reason on the same line (`// any: <reason>`). Fix a real bug the checker finds in its own commit; do not change code only to please the checker.
- **Dates and numbers.** Format them with `dateLocale()` or `numberLocale()` from `js/locale.js` as the locale (`d.toLocaleDateString(dateLocale(), …)`), and start weeks on `weekStart()`, so Appearance's choices apply.
- **Removals.** A removal from the board's data goes through `removeWithUndo()` in `js/remove.js` rather than `confirm()`.
- **Theme.** Use the CSS variables in `:root`. Never hard-code colors in components. Dark values appear in two places (the `prefers-color-scheme` block and `:root[data-theme="dark"]`); update both when you change a token.
- **Phone width.** Keep the 16px side gutter and avoid horizontal scroll. Inputs use 16px font size to prevent iOS zoom.
- **Comments.** Explain why, not what. Keep them short.

## Data and privacy

- Never commit real data. `data/` is ignored, but the user's data folder is normally outside the repo.
- Do not put personal details (names, emails, real project names, real financial figures) in code, fixtures, tests, or docs. Use placeholders.

## Git workflow

- Start from the default branch: `git fetch origin`, then `git checkout -b <type>/<short-description> origin/main`. Types: `feat/`, `fix/`, `refactor/`, `docs/`.
- Make small commits, one logical change each. Explain why in the message, not only what.
- Commit messages describe only the code change. Do not add `Co-authored-by`, `Signed-off-by`, or attribution lines unless the user asks.
- Check the commit identity before committing: `git var GIT_AUTHOR_IDENT` and `git var GIT_COMMITTER_IDENT`. Use the identity already configured. Do not change it.
- Open PRs against `main`. Do not push to `main` directly.
- Commit regularly, in small steps. The commits should tell a story: each one is a step the next one builds on, so reading the log explains how the change came together.
- Keep commit subjects short (about 60 characters) and say what changed. Add a body only when the why is not obvious. No padding, and do not restate the diff.
- Keep PR titles short. The description lists what changed and how it was checked, in a few lines.
- **Never leave a PR unmerged.** Every PR you open is merged in the same turn, as soon as the strict syntax check passes and the change is complete. Do not ask whether to merge, do not wait for approval, and do not end a turn with an open PR. If a merge is blocked (conflict, failing check), fix it in the same turn and merge; if that is impossible, say so explicitly and stop.
- Before finishing any turn, list open PRs (`gh pr list --state open`). If any are open, merge them now.
- Run the strict check before every commit and again before `gh pr merge`, and stop if it fails: `bun run check` (the syntax loop, `node tools/check-imports.js`, `node tools/check-merge.js`, `node tools/check-board-tasks.js` and `bun run typecheck`). Never commit with `--no-verify`.
