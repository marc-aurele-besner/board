# CLAUDE.md

Read `AGENTS.md` first. It holds the project layout, conventions, verification steps and git workflow, and it applies to Claude as much as to any other agent.

Claude-specific notes:

- No build tools or packages are needed. Use plain `node --check` (see `AGENTS.md`) for syntax, and a static server for manual testing.
- When changing a module's data shape, check which other sections read that collection (for example, todos read projects) and update them in the same change.
- Before a larger feature, outline the change in a short plan and get the user's agreement. Smaller fixes can go straight in.
- Commit in logical steps on a feature branch from `origin/main`. Open the PR against `main` with `gh pr create`.
- Commit regularly, so the log tells a story: one step per commit, subjects short, bodies only when the why is not obvious.
- Keep PR titles and descriptions short.
- **Never leave a PR unmerged.** Merge every PR you open in the same turn, once `bun run check` passes (run it right before `gh pr merge`). Never use `--no-verify`. Before ending a turn, run `gh pr list --state open` and merge anything still open.
