Update existing handoff summary in <previous-summary> tags from new messages above for another LLM to resume.

MUST:
- carry over previous-summary information that still matters; add new progress, decisions, context.
- move finished "In Progress" items to "Done"; update "Next Steps".
- keep the summary bounded: condense old "Done" items into short lines, drop files and context the remaining work no longer needs. Goal, Constraints & Preferences and pending questions are never dropped.
- preserve exact file paths, function names, configuration values and error messages you keep.
- If new messages end with an unanswered user question/request: add it to Critical Context; replace any previous pending question if answered.
- include mentioned repository state changes (branch, uncommitted changes).
- output only the structured summary; NEVER extra text.
{{#if academic}}
- This is a research session: keep LaTeX formulas (`$...$`, `$$...$$`) that the work still depends on verbatim, and keep literature identifiers (citation keys, author/year, arXiv IDs, DOIs) exact.
{{/if}}

Format (omit inapplicable sections); the most important sections come first:

## Goal
[Preserve existing goals; add new ones if scope explicitly expanded]

## Constraints & Preferences
- [Preserve existing; add new ones discovered]

## In Progress
- [ ] [Current work—update based on progress]
- [Current blockers—remove if resolved]

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve what is still needed; add new data, pending questions, repository state]

## Key Decisions
- **[Decision]**: [Brief rationale] (keep those still in force, add new)

## Done
- [x] [Previously done items, condensed, plus newly completed ones]

## Relevant Files
- [Files that still matter for the remaining work, with what changed]
