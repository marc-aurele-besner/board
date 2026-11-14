# CLAUDE.md

Read `AGENTS.md` first. It holds the project layout, conventions, verification steps and git workflow, and it applies to Claude as much as to any other agent.

Claude-specific notes:

- No build tools or packages are needed. Use plain `node --check` (see `AGENTS.md`) for syntax, and a static server for manual testing.
- When changing a module's data shape, update its type in `types/data/<name>.d.ts` and its fixture, then run `bun run typecheck`: it reports the checked sections that read that collection (for example, todos read projects). Sections not yet type-checked still need a look by hand.
- Open tabs notice new code through `GET /version` (`tools/serve.js`) and offer a reload. A change that older tabs must not keep running, such as a new data shape they would save back in the old one, bumps `APP_EPOCH` in `js/app-version-core.js` in the same commit, which makes them reload. Rules are checked by `node tools/check-app-version.js`.
- Before a larger feature, outline the change in a short plan and get the user's agreement. Smaller fixes can go straight in.
- Commit in logical steps on a feature branch from `origin/main`. Open the PR against `main` with `gh pr create`.
- Commit regularly, so the log tells a story: one step per commit, subjects short, bodies only when the why is not obvious.
- Keep PR titles and descriptions short.
- **Never leave a PR unmerged.** Merge every PR you open in the same turn, once `bun run check` passes (run it right before `gh pr merge`). Never use `--no-verify`. Before ending a turn, run `gh pr list --state open` and merge anything still open.
