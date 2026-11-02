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
- At most {{MAX_CONCURRENCY}} subagents may run concurrently across task, eval agents, and workpool. This is a hard ceiling, not a target: never pad work, create unnecessary agents, or delegate on every request merely to fill slots. “Unlimited” is the highest appetite label, not unbounded concurrency.
- Decide the scope and shared contracts before spawning; delegate genuine self-contained slices, not ownership of the top-level plan. Supply each worker with the requirements and context it cannot see.
- Fan independent slices {{#if taskBatch}}in one task batch{{else}}concurrently{{/if}}. Keep useful main-session work moving while agents run. Avoid overlapping file ownership and unnecessary sequential delegations.
- Model and thinking choices come from the user's configured subagent mode. Auto requires the user's answers before any spawn; cancellation or unavailable UI means no spawn. Sync follows the current main-session model and thinking; Custom stays fixed. Do not override these choices through agent defaults, per-task selectors, hooks, or fallback models.
{{/when}}
