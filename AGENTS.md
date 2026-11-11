# AGENTS.md

Guidance for any coding agent working in this repository.

## What this is

A personal command center that runs locally. It is plain HTML, CSS and JavaScript ES modules with no backend, no build step and no runtime dependencies. Data lives as JSON files in a folder the user picks through the File System Access API. Read `README.md` for the user-facing description and the data format.

## Run and verify

- Start the board with `bun start` (or `node tools/start.js`): it runs the static server, the API relays and the command runner together, each logging with its name as prefix. `bun dev` runs the same and restarts them when a file in `tools/` changes. `bun run serve` alone serves the folder. Then open `http://localhost:8000` in Chrome or Edge. The File System Access API needs a secure context (`localhost` counts) and does not work in Firefox or Safari.
- A changed module is not always picked up: `python3 -m http.server` sends no cache headers, so the browser reuses the module it cached and keeps running the old code. `tools/serve.js` marks every file `no-cache`, so a reload runs the new code. With the Python server, ask the user for a hard reload (Cmd+Shift+R) before checking a change in the browser.
- Syntax check every module before committing:
  `for f in js/*.js js/modules/*.js; do node --experimental-default-type=module --check "$f" || echo "FAIL $f"; done`
- Test real behavior in the browser when you can. Folder picking needs a user click, so ask the user to drive that step if you cannot.

## Layout

```
index.html            entry point; inline script applies the saved theme before paint
oauth.html            where Google's sign-in comes back; hands the code to the board's tab
css/style.css         design tokens (light and dark) and all styles
js/app.js             shell: folder connection, router, top nav, theme toggle
js/storage.js         File System Access API wrapper; remembers the folder in IndexedDB
js/store.js           in-memory state; debounced, serialized saves; subscriptions
js/keep-fields.js     keeps unsubmitted fields across re-renders; holds background re-renders while typing
js/ui.js              h() DOM helper, icon(), ids, dates, money formatting
js/modules/index.js   registry of sections (the nav is built from this list)
js/modules/*.js       one file per section (todos, projects, kitchen, money, tools, ...)
js/notifications.js   the bell, its drawer, and notify(); saved in notifications.json
js/automations.js     site checks and the rules that turn their results into tasks
js/terminal.js        Dev's calls to the command runner: info, folders and files, a command's streamed output, keys
js/folder-picker.js   the dialog that finds a folder on this machine through the runner (Projects → Local folder)
js/vt.js              the terminal emulator Dev draws command output with (cursor moves, colours, alternate screen)
js/highlight.js       syntax colours for the Dev file reader, per language, with no dependency
js/sitecheck.js       the lookups behind Tools (health, domain, certificate, share tags)
js/telegram.js        tasks from Telegram messages, read while the board is open
js/ai.js              the one OpenRouter call; logs each call's input, output and details to usage.json
js/prompts.js         the system prompt of every AI feature; Settings → Prompts overrides them
js/chart.js           SVG bar charts with a hover tooltip
js/chains.js          every chain the board reads: the built-in ones and those added in Settings → Blockchains
js/abi.js             Solidity ABI encoding and decoding: calls, answers and event logs
js/contracts.js       saved smart contracts: reads through the node, writes through the browser wallet, activity
js/pool-insights.js   the Liquidity Pools AI insights: in and out of range positions, and what to adjust
js/multicall.js       Multicall3: many read-only calls in one request
js/balances.js        native and token balances of the DeFi wallets (DeFi → Wallets)
js/aave.js            Aave v3 supply, debt and health factor of the DeFi wallets (DeFi → Lending / Borrowing)
js/resend.js          the Inbox's Resend reads: email lists per project key, and one email's body
js/google.js          every Google sign-in, kept in google.json and renewed before it expires; account pictures
js/gmail.js           the Inbox's Gmail reads: one sign-in per account, its email list, and one email's body
js/gcal.js            Calendar's Google reads: one sign-in per account, its calendar list, and the events of a range
js/background.js      timers for the above; started once the data folder is open
js/capture.js         parseTask(), parseMoney() and makeTask(): one place for a task's shape
js/palette.js         the Cmd/Ctrl+K search palette: jump, or capture a task, a Money entry or a recipe link
js/search.js          what the full search page (modules/search.js, hidden) looks through, grouped by kind
js/task-query.js      the Tasks search: words plus #project, !priority, is:status, cat: and due: filters
js/shortcuts.js       the single-key shortcuts ("g" then a letter) and the sheet that lists them
js/sample.js          "Explore with sample data": a data folder in memory with placeholder content
fonts/                bundled typefaces (SIL Open Font License)
package.json          scripts only (start, serve, relays); no dependencies
tools/start.js        one command for the board: starts serve.js and relays.js together
tools/log.js          terminal lines prefixed with each runner's name
tools/serve.js        local static server with no-cache headers; no dependencies
tools/relays.js       local relays for Bing's and Resend's APIs (Inbox), which send no CORS header
tools/terminal.js     the Dev section's runner: commands in a pseudo-terminal, typed keys, read-only file reads; localhost only
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
- **Cross-section data.** A section may read another section's collection through the store (todos read projects). Write to the other collection with its own `store.update` call.
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
- Run the strict syntax check before every commit, and stop if it fails: `for f in js/*.js js/modules/*.js; do node --experimental-default-type=module --check "$f" || { echo "FAIL $f"; exit 1; }; done`
