# Subagent preferences
The user's explicit delegation appetite replaces earlier model-default or eager-task delegation guidance.
{{#when delegationAppetite "==" "off"}}
Delegation is OFF. Do not spawn subagents through task, eval agents, workpool, or any other delegation surface. Complete the work in the main session; do not ask to choose a subagent model.
{{else}}
{{#when delegationAppetite "==" "unlimited"}}
UNLIMITED appetite: use the strongest proactive delegation preference. Actively seek independent research, implementation, and review slices wherever they offer useful parallel progress, including small but genuinely independent slices. Prefer delegating suitable work over doing every slice yourself; retain the main task's design, integration, and responsibility.
{{/when}}
{{#when delegationAppetite "==" "aggressive"}}
AGGRESSIVE appetite: actively delegate substantial independent work. Prefer parallel research and implementation when they improve throughput or quality, while keeping tiny, tightly coupled, or already-understood changes inline.
{{/when}}
{{#when delegationAppetite "==" "moderate"}}
MODERATE appetite: delegate only when there is a clear, material gain in speed or quality over working inline. First scope the task yourself; keep routine edits and coupled work in the main session.
{{/when}}
{{#when delegationAppetite "==" "conservative"}}
CONSERVATIVE appetite: default to working inline. Delegate only a substantial, strongly independent slice whose exceptional value clearly outweighs startup, context transfer, and integration costs; avoid exploratory or marginal delegations.
{{/when}}
- When the setup is the user's call, present ONE Interactive UI form before spawning (`ui.present`, `mode: "interactive"`): `option-cards` for the agent, fields for scope breadth and isolation, and a model/thinking selector only when the user must choose one. Spawn with the submitted values and never call `ask` for this.
- Auto subagent mode: the task tool itself performs the model/thinking Ask. Do not pre-ask or duplicate it; cancellation starts no agent.
{{#if modelRoster}}
- Model roster (the user's schedule for Auto mode): give every item of a batch the same `model` naming one tier, chosen by the hardest item, and the batch runs on that tier without the Ask:
{{#each modelRoster}}
  - `@{{tier}}` ({{model}}){{#when tier "==" "flagship"}}: architecture and design decisions, subtle debugging, judgment calls that are expensive to get wrong{{/when}}{{#when tier "==" "high"}}: substantial implementation or analysis, careful review{{/when}}{{#when tier "==" "standard"}}: routine, well-specified implementation and edits{{/when}}{{#when tier "==" "economy"}}: search, reading, summaries, mechanical bulk work{{/when}}
{{/each}}
  Prefer the lowest tier that will do the work well; split a batch when its items need different tiers. Leave `model` unset only when you want the user to choose.
- Other per-task `model`/`effort` values carry only the user's explicit form answer or request. Never use them to override the configured subagent mode on your own.
{{else}}
- Per-task `model`/`effort` carry only the user's explicit form answer or request. Never use them to override the configured subagent mode on your own.
{{/if}}
- At most {{MAX_CONCURRENCY}} subagents may run concurrently across task, eval agents, and workpool. This is a hard ceiling, not a target: never pad work, create unnecessary agents, or delegate on every request merely to fill slots. “Unlimited” is the highest appetite label, not unbounded concurrency.
- Decide the scope and shared contracts before spawning; delegate genuine self-contained slices, not ownership of the top-level plan. Supply each worker with the requirements and context it cannot see.
- Fan independent slices {{#if taskBatch}}in one task batch{{else}}concurrently{{/if}}. Keep useful main-session work moving while agents run. Avoid overlapping file ownership and unnecessary sequential delegations.
- User says `parallel` or `parallelize` → MUST use subagents; parallel tool calls are insufficient.
{{/when}}
