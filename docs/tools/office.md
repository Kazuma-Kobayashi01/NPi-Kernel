# office

> Assign work down a Virtual Office and move it back up through reviewed pull requests.

See [Virtual Office](../virtual-office.md) for the feature as a whole.

## Source

- Entry: `packages/coding-agent/src/office/tool.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/office.md`; role briefs in `packages/coding-agent/src/prompts/office/`
- Key collaborators:
   - `packages/coding-agent/src/office/company.ts` — resolves the session's seat and merges approved pull requests.
   - `packages/coding-agent/src/office/pulls.ts` — the pull request ledger and the review chain.
   - `packages/coding-agent/src/office/workspace.ts` — branches, worktrees ("desks") and the merge itself.
   - `packages/coding-agent/src/task/structured-subagent.ts` — runs each member as a subagent at their desk.

## Registration / Visibility

- Tool metadata: `approval = "exec"`, `strict = true`, `loadMode = "essential"`.
- Registered only when `office.enabled` is `true` and the session has a seat:
   - the main session, in a git repository with a branch checked out, is the general manager;
   - a session started by `assign` at an office's worktree is that office's leader;
   - a session started at a worker's worktree is that worker.
- Any other subagent has no seat and does not get the tool.

## Inputs

| Field | Type | Used by | Description |
| --- | --- | --- | --- |
| `action` | `status` \| `assign` \| `submit` \| `diff` \| `review` \| `merge` | all | What to do. |
| `assignments` | `{ to, task }[]` | `assign` | `to` is an office number for the general manager, a worker name for a leader. Entries run concurrently. |
| `pr` | `number` | `diff`, `review`, `merge` | Pull request number. |
| `title`, `body` | `string` | `submit` | Pull request title and description. |
| `verdict` | `approve` \| `request_changes` | `review` | The decision. |
| `comment` | `string` | `review` | Feedback; required with `request_changes`. |
| `note` | `string` | `remember` | One lesson about the project, at most 600 characters. |

## Actions by seat

| Action | General manager | Leader | Worker |
| --- | --- | --- | --- |
| `status` | all offices and pull requests | own office | own pull requests |
| `assign` | to offices | to own workers | — |
| `diff` | any pull request | any pull request | any pull request |
| `review` | office pull requests | own workers' pull requests | — |
| `merge` | — (the user merges with `/office merge`) | approved worker pull requests | — |
| `submit` | — | the office's pull request | own pull request |
| `remember` | — (asks an office to) | a lesson for the office | a lesson for the office |

`assign` blocks until every assignee finishes and returns each one's report with the pull requests waiting from them. A desk takes one assignment at a time. `submit` commits uncommitted work at the desk first and fails when the branch has nothing its target lacks; submitting again while a pull request is unfinished updates that pull request and puts it back up for review.

Role briefs carry the office's memory of the project (lessons and merged work), read when the assignment starts; see [Office memory](../virtual-office.md#office-memory).

## Outputs

Text for the model, plus `details`: `{ action, seat, pulls? }`, where `pulls` lists the pull requests the call opened, changed or listed.
