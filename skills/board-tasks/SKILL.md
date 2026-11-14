---
name: board-tasks
description: List, add and edit tasks on the user's board (their local command center) from a Dev terminal the board opened, and read what surrounds them. Use it before coding to see whether other sessions already work on the same task (their worktrees, branches, commits); to read the task's project (profile, repos, folder, links) or its saved brand as CSS or JSON for design work; to fetch a task's images (e.g. a bug screenshot) or attach one (a screenshot proving a change works); and when the work turns up a follow-up, to file it as a subtask, check whether it was already filed, or update its status. Only works where BOARD_SESSION_TOKEN is set.
---

# Board tasks

The board started this session in one of its Dev terminals, usually for a task (the prompt names it). From here
you can reach that task and the tasks under it, nothing else:

- **Read** the session's task (read-only: the board moves it to In progress, then to review, by itself), every task
  under it, and every task this session made.
- **Add** subtasks under the session's task, or under any of those tasks. They show on the board with a **Dev** badge.
- **Edit** the tasks under the session's task and the ones this session made. Never delete: set a task you no longer
  want to `parking`, or to `done` if it is done.
- At most **100** tasks per session, all subagents together.
- **Read** the other open Dev terminals on those tasks, the tasks' project and its brand, and the tasks' images.
- **Attach** images to those tasks (the session's own task too): PNG, JPEG, GIF or WebP, 5 MB at most.

If `BOARD_SESSION_TOKEN` is not set, this terminal was not opened by the board: say so and stop.

## Commands

Run them with node, from any folder (`$BOARD_CLI` is the command's full path):

```sh
node "$BOARD_CLI" task list                    # the session's tasks as a tree, with their ids
node "$BOARD_CLI" task list --q "rate limit"   # only tasks whose title or description holds every word
node "$BOARD_CLI" task show <id>               # one task, with its description
node "$BOARD_CLI" task add "Title" --description "Why, and what done means" --priority medium
node "$BOARD_CLI" task add "Title" --parent <id>   # under another of the session's tasks
node "$BOARD_CLI" task edit <id> --status done     # also --title, --description, --priority, --due, --category, --parent
```

```sh
node "$BOARD_CLI" session                      # other terminals on these tasks: worktree, branch, last commit, changes
node "$BOARD_CLI" task sessions <id>           # the same, for one task
node "$BOARD_CLI" project                      # the task's project: folder, repos, links, saved profile
node "$BOARD_CLI" brand --css                  # its brand as CSS custom properties (--json for the lists)
node "$BOARD_CLI" image list <id>              # a task's images, numbered
node "$BOARD_CLI" image get <id> [n]           # saves image n (default: all) and prints the path to read
node "$BOARD_CLI" image add <id> shot.png --name "After the fix"
```

When the session's tasks span several projects, `project` and `brand` take `--project <id>`. `image get` takes
`--out <file or folder>`; by default it saves in the system's temp folder.

Add `--json` to `list`, `show`, `session`, `project` or `image list` for the full fields. Statuses: `parking`, `blocked`, `todo`, `paused`, `ondeck`,
`doing`, `review`, `done`. Priorities: `high`, `medium`, `low`, `none`. Due dates: `YYYY-MM-DD`, or `""` for none.

## How to use it well

1. **Check other sessions before coding.** Run `session` first: another terminal may already work on this task or a
   subtask. Read its branch and last commit (`git log <branch>`) and build on it, or pick a part it does not touch,
   rather than redoing it.
2. **Use the saved context.** `project` gives the project's profile and repos without re-reading the repo; design
   work (wireframes, share images, logos, landing pages) starts from `brand --css` instead of re-extracting it.
3. **Read the task's images.** A bug report often carries a screenshot: `image get <id>` and read the path it prints.
   When a change shows on screen, attach a screenshot of it working with `image add`.
4. **Look before adding.** Run `task list --q <a few key words>` first: a subagent or another session on the same
   task may already have filed it. Edit that task rather than adding a second one.
5. **One task, one outcome.** Give it a title that says what to do and a description with the why and the files or
   links that matter, so it can be picked up later with no other context.
6. **Nest.** A step of a step goes under that step (`--parent <id>`), not next to it.
7. **Keep it honest.** Set a subtask to `doing` when you start it and `done` when it is finished. Leave the session's
   own task alone: the board moves it.
8. **Do not file what you are about to do right now.** Subtasks are for follow-ups, separate fixes and work you are
   handing on, not a to-do list of this turn.

A refusal (`Refused: …`) says why: another task, the limit, a parent that would loop, a file that is not an image. It is not worth retrying
unchanged.
