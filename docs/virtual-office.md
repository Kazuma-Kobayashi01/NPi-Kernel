# Virtual Office

Virtual Office runs a session as a small company. The main chat is the **general manager**: it plans and reviews, and hands anything that changes files to an **office**. Each office has one **leader**, who splits the work and reviews it, and two to five **workers**, who do it. Every member works on their own git branch, and a change reaches your branch only through reviewed pull requests. The last merge is always yours.

Turn it on with `/office on` (or `npi office on`, or Settings → Tasks → Virtual Office). It needs a git repository with a branch checked out; elsewhere the session works as usual.

## The company

| Setting | Values | Meaning |
| --- | --- | --- |
| `office.enabled` | `true` / `false` | Run the main chat as general manager. |
| `office.scale` | `team`, `studio`, `enterprise` | 1, 3 or 6 offices. |
| `office.offices` | list | The roster. Edit it with the commands below, not by hand. |

Each member has:

- a **name**, `Worker-xxxxxx`, given once and kept until the member is removed. Scaling down leaves the extra offices in the roster, so scaling back up brings the same members back;
- a **role**: one `leader` per office, the rest `worker`;
- a **model**: any model selector, or empty for the default subagent model;
- a **capability**: `common`, `professional` or `expert`. The leader gives hard, open-ended work to experts and mechanical, well-specified work to common members.

An office has three to six members. A new office starts with a leader and two workers.

## Commands

In the terminal UI, `/office` on its own opens the **Virtual Office panel**, a full screen like `/settings`: a tab for the company, one per office and one for pull requests. Move with ↑/↓, switch tabs with ←/→, press Enter to open or change the selected row, and Esc to go back. From it you can turn Virtual Office on or off, set the company size and each office's member count, add or remove workers, change a member's model, capability or make them leader, merge or send back the office pull requests waiting for you, and add to or clear an office's memory. The panel runs the same commands as below, so the two never disagree.

`/office <subcommand>` in a session and `npi office` in a shell take the same subcommands.

| Command | Effect |
| --- | --- |
| `/office status` | Show the roster and the pull requests that are not finished. Outside the terminal UI, `/office` alone does the same. |
| `/office on` · `/office off` | Turn Virtual Office on or off. |
| `/office scale team\|studio\|enterprise` | Set the number of offices. |
| `/office size <office> <3-6>` | Set an office's member count. Added members are workers; removed ones are the newest workers. |
| `/office add <office> [model] [capability]` | Add a worker. |
| `/office remove <name>` | Remove a worker. A leader cannot be removed; promote someone else first. |
| `/office set <name> model <selector>` | Set a member's model (`default` clears it). |
| `/office set <name> capability <level>` | Set a member's capability. |
| `/office set <name> role leader` | Make a member the leader; the previous leader becomes a worker. |
| `/office merge <pr>` | Merge an approved office pull request into your branch. |
| `/office reject <pr> <reason>` | Send an office pull request back. |
| `/office memory <office>` | Show what an office remembers about this project. |
| `/office remember <office> <lesson>` | Give an office a lesson to keep. |
| `/office forget <office>` | Clear what an office remembers about this project. |

`npi office --json` prints the same state the RPC command returns.

## Branches and pull requests

With `main` checked out, office 1 and its worker `Worker-1a2b3c` work on:

```
main                              your checkout; the general manager sits here
└─ office/main/o1/main            office 1; its leader's worktree
   └─ office/main/o1/Worker-1a2b3c   one worker's worktree
```

The worktrees live under the worktree base directory (`worktree.base`, default `~/.omp/wt`) in `office/<repository>/<branch>/`. They are created the first time work is assigned and reused afterwards. A desk with no unmerged work is moved up to the branch above it before each assignment.

Work moves up one level at a time:

1. A worker commits on their branch and submits a pull request to the office branch.
2. The office's leader reviews it, then merges it or requests changes.
3. When the assignment is done, the leader submits the office branch as a pull request to your branch.
4. The general manager reviews it and approves or requests changes.
5. You merge it with `/office merge <pr>`, or send it back with `/office reject <pr> <reason>`.

The rules are enforced by the tool, not only by the prompts: a pull request is reviewed only by the level directly above its author, nothing merges without an approval, and only you can merge into your branch.

Pull requests are local records kept in the repository's git directory (`npi-office/pulls.json`). Nothing is pushed and no GitHub pull request is created.

A merge adds one commit, `Merge PR #<n>: <title>`, holding the whole change. It is refused, with nothing changed, when the target branch has staged changes or has changed the same lines since the work started; the author then rebases onto the target and submits again.

## Office memory

Each office remembers the project it works on, the way a department builds up experience with a client. Memory is kept per repository, so it survives branch switches and new sessions, and two projects never share it.

- **Merged work** is logged automatically: every pull request the office gets merged, with its author, target branch and changed files. The last 30 are kept.
- **Lessons** are written by the office's members with `office` `remember` (or by you with `/office remember`): conventions, traps, how to check a change. Up to 40 are kept, each at most 600 characters; a lesson already kept word for word is not added again.

The leader and workers see their office's memory with every assignment, next to their role brief. The general manager's brief lists each office's latest merged work and how many lessons it keeps, so follow-up work can go to the office that did the earlier part. The general manager has no memory of its own here; it tells an office what to remember.

Memory lives next to the pull requests in the repository's git directory (`npi-office/memory.json`). It is never committed or pushed.

## For GUI hosts

Two RPC commands cover everything the CLI does:

| Command | Result |
| --- | --- |
| `get_office_state` | `OfficeState`: `enabled`, `scale`, `offices` (numbered, with members), `company` (`checkout`, `baseBranch`, or `null` with a `reason`), `pulls` (every pull request with its reviews), and `memory` (each office's lessons and merged-work log). |
| `office_command` with `args: string[]` | Runs one subcommand from the table above, e.g. `["set", "Worker-1a2b3c", "capability", "expert"]` or `["merge", "4"]`. Returns `text` (what the CLI prints), `failed` when the command was refused, and the new `state`. |

Members run as ordinary subagents named after the member, so `get_subagents`, subagent events and transcripts show who is working. The session's `office` tool calls carry `details.pulls`, the pull requests the call opened or changed.
