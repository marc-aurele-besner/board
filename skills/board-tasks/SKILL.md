---
name: board-tasks
description: List, add and edit tasks on the user's board (their local command center) from a Dev terminal the board opened. Use it when the work turns up a follow-up, a separate fix or a step worth tracking on its own, to file it as a subtask of the task this session works on; to check whether a subagent or another session already filed it; or to update the subtasks' status as they get done. Only works where BOARD_SESSION_TOKEN is set.
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

Add `--json` to `list` or `show` for the full fields. Statuses: `parking`, `blocked`, `todo`, `paused`, `ondeck`,
`doing`, `review`, `done`. Priorities: `high`, `medium`, `low`, `none`. Due dates: `YYYY-MM-DD`, or `""` for none.

## How to use it well

1. **Look before adding.** Run `task list --q <a few key words>` first: a subagent or another session on the same
   task may already have filed it. Edit that task rather than adding a second one.
2. **One task, one outcome.** Give it a title that says what to do and a description with the why and the files or
   links that matter, so it can be picked up later with no other context.
3. **Nest.** A step of a step goes under that step (`--parent <id>`), not next to it.
4. **Keep it honest.** Set a subtask to `doing` when you start it and `done` when it is finished. Leave the session's
   own task alone: the board moves it.
5. **Do not file what you are about to do right now.** Subtasks are for follow-ups, separate fixes and work you are
   handing on, not a to-do list of this turn.

A refusal (`Refused: …`) says why: another task, the limit, a parent that would loop. It is not worth retrying
unchanged.
