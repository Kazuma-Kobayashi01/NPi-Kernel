{{#if asyncEnabled}}{{#if batchEnabled}}Spawn `tasks[]` concurrently; IDs return immediately.{{else}}Spawn one agent; ID returns immediately.{{/if}}{{#if hasBlockingAgents}} BLOCKING agents return inline.{{/if}}{{else}}{{#if batchEnabled}}Run `tasks[]` synchronously.{{else}}Run one agent synchronously.{{/if}}{{/if}}
{{#if asyncEnabled}}{{#ifAny structured hasStructuredAgents}}

# Results
{{#if structured}}`outputSchema`{{else}}STRUCTURED agents'{{/if}} parsed payload, even invalid: `agent://<id>` (field `/<field>`, nested `/reports/0/data`); invalid preview inline.
{{/ifAny}}

{{asyncGuidance}}
{{/if}}

# Delegation
Use most specific agent.{{#if scoutAvailable}} Read-only research MUST use `scout` only when files unknown.{{/if}} Prefer one agent to investigate + edit. Omit `agent` only for default (`{{defaultAgent}}`); NEVER specify it.
{{#if batchEnabled}}Specialist `agent` selectors belong inside each `tasks[]` item; NEVER put `agent` at the top level.
{{/if}}
Shared edits need one integration owner{{#if ircEnabled}}; siblings coordinate via `write agent://<id>`{{/if}}. Set interfaces in {{#if batchEnabled}}`context`{{else}}the task{{/if}}. Every task MUST skip build/lint/tests/formatters mid-flight; the main agent runs them once after all subagents land.
When the user has not already fixed the setup, present ONE Interactive UI form (`ui.present`, `mode: "interactive"`) covering agent, scope, and isolation — plus a model/thinking selector only when the user must choose — then spawn with the submitted values. Never call `ask` for this. In Auto mode the tool performs the model/thinking Ask itself; do not pre-ask.

# Inputs
{{#if file}}`taskFile`: absolute path or `local://` file; contents become the task, read once at dispatch. Exactly one of `task`/`taskFile`.
{{/if}}
`name`: CamelCase ≤32, auto-generated if omitted; address agent by name.{{#if structured}} `outputSchema` overrides agent/session schemas.{{/if}}
`model`: selector or prioritized array for this spawn; set it only from the user's form answer or explicit request, never to override the configured subagent mode on your own. {{#if batchEnabled}}Set it on each `tasks[]` item.{{/if}}
`solutionSpace`: describe how open-ended the child's problem is: whether the fix or design is given, or which causes or designs remain open. Volume of work does not widen it; NEVER mention sibling agents or coordination. (`one fix: rename, names given`; `one fix: slice end in paginate`; `single-flight cache load; races easy to miss`; `several retry API shapes; error classes to choose`; `deadlock cause open, no repro`)
{{#if seanceGuidance}}{{seanceGuidance}}{{/if}}
{{#if evalToolsEnabled}}`tools`: eval-defined, run in your kernel.
{{/if}}{{#if effortEnabled}}`effort`: `"lo"`|`"med"`|`"hi"` by how open-ended the problem is.
{{/if}}{{#if structured}}`schemaMode`: default permissive warns after retries; strict fails.
{{/if}}{{#if isolationEnabled}}{{#if applyIsolatedChanges}}`isolated`: worktree; successful changes apply to parent.
{{else}}`isolated`: worktree; changes retained, not applied.
{{/if}}{{/if}}Children start blank;{{#if ircEnabled}} parent IRC steers immediately;{{/if}} large payloads via `local://<path>`, NEVER inline.

# Format
{{#if batchEnabled}}`context`: shared (`# Goal`, `# Contract` interfaces); NEVER repeat per task.
{{/if}}`task`{{#if file}} or the contents of `taskFile`{{/if}}: self-contained (`# Target` files/non-goals, `# Change` steps/APIs, `# Acceptance` observable result).

# Available Agents
{{#if spawningDisabled}}Agent spawning is currently disabled.
{{else}}{{#if hasModelMentions}}`m<N>` = user-tagged model (`<model agent="m<N>" name="…"/>`), not specialist; spawn only when user names it.
{{/if}}{{#list agents join=""}}- `{{name}}`{{#if readOnly}} (READ-ONLY; investigation only, no edits){{/if}}{{#if blocking}} (BLOCKING; inline result){{/if}}{{#if structured}} (STRUCTURED; schema result){{/if}}: {{description}}
{{/list}}{{/if}}
