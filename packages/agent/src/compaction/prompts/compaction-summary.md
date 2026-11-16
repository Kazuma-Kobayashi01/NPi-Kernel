You MUST summarize the conversation above into a structured handoff summary for another LLM to resume the task.

IMPORTANT: If the conversation ends with an unanswered question or a request awaiting user response (e.g., "Please run command and paste output"), you MUST preserve that exact question/request.

You MUST use this format (sections can be omitted if not applicable); the most important sections come first:

## Goal
[The user's goal in their own words; list multiple if the session covers different tasks. Keep the original request's intent; NEVER dilute it.]

## Constraints & Preferences
- [Rules the user set for this work (branch rules, forbidden actions, conventions) and constraints discovered during execution]

## In Progress
- [ ] [Current work]
- [Blockers, if any]

## Next Steps
1. [Ordered list of next actions]

## Critical Context
- [Data needed to continue: exact file paths, symbol names, key configuration values, error messages, relevant command results, pending questions]
- [Repository state if mentioned: branch, uncommitted changes]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Done
- [x] [Completed tasks/changes]

## Relevant Files
- [Files that still matter for the remaining work, with what changed]

You MUST output only the structured summary; you NEVER include extra text.

Keep sections concise: compress what is finished, keep exact what the next step needs. Preserve exact file paths, function/type names, configuration values and error messages you keep.
{{#if academic}}
This is a research session: keep LaTeX formulas (`$...$`, `$$...$$`) that the work still depends on verbatim, and keep literature identifiers (citation keys, author/year, arXiv IDs, DOIs) exact.
{{/if}}
