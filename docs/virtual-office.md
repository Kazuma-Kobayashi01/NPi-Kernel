# Virtual Office

Virtual Office gives a session a research department. The main chat is the **general manager**: it decides and makes the changes itself, and it can hand **questions** to an **office** — understand unfamiliar code, trace a bug, compare approaches, check how something is used across the project, look things up on the web. Each office has one **leader**, who owns the answer, and two to five **workers**, who investigate the parts the leader gives them. Members only read: they cannot run commands or change any file. Every assignment ends with a **report**, and the general manager acts on it.

Turn it on with `/office on` (or `npi office on`, or Settings → Tasks → Virtual Office). It needs a git repository; elsewhere the session works as usual.

## The company

| Setting | Values | Meaning |
| --- | --- | --- |
| `office.enabled` | `true` / `false` | Give the main chat offices to hand questions to. |
| `office.scale` | `team`, `studio`, `enterprise` | 1, 3 or 6 offices. |
| `office.offices` | list | The roster. Edit it with the commands below, not by hand. |
| `office.assignmentTimeoutMs` | ms, default `900000` | Longest one worker investigation may run before it is stopped and reported as not finished. A leader, whose assignment includes its workers' runs, gets four times as long. `0` uses the subagent limit (`task.maxRuntimeMs`). |

Each member has:

- a **name**, `Worker-xxxxxx`, given once and kept until the member is removed. Scaling down leaves the extra offices in the roster, so scaling back up brings the same members back;
- a **role**: one `leader` per office, the rest `worker`;
- a **model**: any model selector, or empty for the session's configured subagent model;
- a **thinking** effort — `off`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max` — or empty to follow the same setting the model comes from. An effort the model does not support is clamped to the closest one it does;
- a **capability**: `common`, `professional` or `expert`. The leader gives the hard, open-ended parts to experts and narrow lookups to common members.

An office has three to six members. A new office starts with a leader and two workers.

## How a question is answered

1. The general manager assigns a question to an office with the `office` tool (`assign`). Independent questions can go to several offices in one call; they run at the same time, and the call returns when all have reported.
2. The office's leader answers a small question itself. A large one it splits into parts that do not overlap and assigns them to its workers in one call, so they run at the same time; then it checks their findings and combines them.
3. The leader's final message is the office's report: the answer first, the evidence (`path:line` references, quotes, links), what could not be confirmed, and suggested next steps. It is the result of the general manager's `assign` call.
4. The general manager reads the report, checks what it will act on, and makes the change itself.

Members run in your checkout with reading tools only — `read`, `grep`, `glob`, `find`, `ast_grep`, `web_search` — plus the `office` tool for their own seat. They have no shell, no write or edit tool and cannot start other subagents, so an office never changes anything. There are no office branches, worktrees, commits or pull requests.

Every report is kept as `npi-office/reports/<run id>.md` in the repository's git directory; the newest 120 are kept. The general manager can read one again with `office` `report`, and you with `/office report <run>`. A member takes one assignment at a time across every process working on the repository (`npi-office/working/`); a claim left by a process that died is dropped.

## Commands

In the terminal UI, `/office` on its own opens the **Virtual Office panel**, a full screen like `/settings`: a tab for the company, one per office and one for reports. Move with ↑/↓, switch tabs with ←/→, press Enter to open or change the selected row, and Esc to go back. From it you can turn Virtual Office on or off, set the company size and each office's member count, add or remove workers, change a member's model, thinking effort (the levels their model takes) or capability or make them leader, read reports, and add to or clear an office's memory. It also shows what each office is doing (who is investigating, the leader's question), spend today and in total (company, general manager, each office and member, estimated at catalog prices) and recent assignments per office and member. The panel follows the company live while open: a change re-reads it, and booked usage is added up in the panel without re-reading. It runs the same commands as below, so the two never disagree.

`/office <subcommand>` in a session and `npi office` in a shell take the same subcommands.

| Command | Effect |
| --- | --- |
| `/office status` | Show the roster and recent reports. Outside the terminal UI, `/office` alone does the same. |
| `/office on` · `/office off` | Turn Virtual Office on or off. |
| `/office scale team\|studio\|enterprise` | Set the number of offices. |
| `/office size <office> <3-6>` | Set an office's member count. Added members are workers; removed ones are the newest workers. |
| `/office add <office> [model] [capability]` | Add a worker. |
| `/office remove <name>` | Remove a worker. A leader cannot be removed; promote someone else first. |
| `/office set <name> model <selector>` | Set a member's model (`default` clears it). |
| `/office set <name> thinking <level>` | Set a member's thinking effort (`default` clears it). |
| `/office set <name> capability <level>` | Set a member's capability. |
| `/office set <name> role leader` | Make a member the leader; the previous leader becomes a worker. |
| `/office report [run]` | List recent reports, or print one. |
| `/office memory <office>` | Show what an office remembers about this project. |
| `/office remember <office> <lesson>` | Give an office a lesson to keep. |
| `/office forget <office>` | Clear what an office remembers about this project. |

`npi office --json` prints the same state the RPC command returns.

Earlier versions had offices change code on their own branches and move it up through local pull requests. That is gone: existing `office/*` branches, the old desk worktrees under the worktree base directory (`office/<repository>/…`) and `npi-office/pulls.json` are no longer read or written, and you can delete them.

## Office memory

Each office remembers the project it works on: **lessons** its members write with `office` `remember` (or you with `/office remember`) — where things live, traps, conventions. Memory is kept per repository, so it survives branch switches and new sessions, and two projects never share it. Up to 40 lessons are kept per office, each at most 600 characters; a lesson already kept word for word is not added again.

The leader and workers see their office's lessons with every assignment, next to their role brief. The general manager's brief lists each office's latest report titles and how many lessons it keeps, so a follow-up question can go to the office that answered the earlier part. Memory lives in the repository's git directory (`npi-office/memory.json`) and is never committed or pushed.

## For GUI hosts

An RPC session starts with Virtual Office **off**, whatever `office.enabled` says for the CLI: a host switches it on per session, so each of its tabs can be a general manager or not.

| Command | Result |
| --- | --- |
| `set_office_enabled` with `enabled: boolean` | Turns Virtual Office on or off for this session only; nothing is saved. The `office` tool and the general manager's brief appear or disappear at once. Returns the new `OfficeState`. |
| `get_office_state` | `OfficeState`, described below. |
| `get_office_report` with `runId: string` | The report that run handed in, as Markdown, or `null` when none is kept. |
| `office_command` with `args: string[]` | Runs one subcommand from the table above, e.g. `["set", "Worker-1a2b3c", "capability", "expert"]`. Returns `text` (what the CLI prints), `failed` when the command was refused, and the new `state`. `["on"]` and `["off"]` act like `set_office_enabled`. |

While Virtual Office is on, the session also sends an `office_state` frame (`{ type: "office_state", state }`) whenever the company changes, so a host never needs to poll. Usage a member books is not a change: it arrives as `office_usage` frames (`{ type: "office_usage", checkout, member, day, amount }`), the spend since the previous frame for that member and local day, coalesced every 250 ms. Add them to `usage` yourself (a later `day` starts `today` over; an earlier one counts only toward `total`); queued deltas are sent before each `office_state`, whose `usage` then replaces your totals. Changes made by another process (a second general manager, `npi office` in a shell) are not pushed; fetch the state again when that matters.

`OfficeState` holds:

- `enabled`, `scale`, `offices` (numbered, with members), and `company` (`checkout`, or `null` with a `reason`);
- `memory`: each office's lessons;
- `activity`: per office, a `phase` (`working` or `idle`), the members `working` right now, and the leader's current `task`;
- `usage`: tokens (input + output + cache writes), estimated USD cost and request count, `today` and in `total`, for the company and per member. The general manager is listed as `general-manager`. `today` is the local calendar day named in `day` and starts at 00:00; an assignment that runs across midnight is split between the two days;
- `runs`: the most recent assignments: who got them, from whom, the question, the member's `sessionFile` (read it with `get_subagent_messages`), when it started and ended, whether it failed, and the `report` title (read the report with `get_office_report`).

Usage and runs are kept in `npi-office/usage.json` in the repository's git directory.

Members run as ordinary subagents named after the member, so `get_subagents`, subagent events and transcripts show who is working. Each assignment is dispatched on that member's configured model and thinking effort, and nobody is asked to pick one: the roster is your confirmation. A member with neither set follows the session's subagent configuration — the Custom model and effort when the host runs Custom subagents, the tier its capability maps to (`expert` → flagship, `professional` → high, `common` → standard) when the host runs Auto, and the session's own active model and effort otherwise. The `office` tool is not approval-gated: it only hands out questions to read-only members.
