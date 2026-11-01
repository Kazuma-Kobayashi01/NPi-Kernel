Update existing handoff summary in <previous-summary> tags from new messages above for another LLM to resume.

MUST:
- preserve all previous-summary information; add new progress, decisions, context.
- Progress: move completed "In Progress" items to "Done".
- update "Next Steps" for completed work.
- preserve exact file paths, function names, error messages.
- MAY remove irrelevant content.
- If new messages end with an unanswered user question/request: add it to Critical Context; replace any previous pending question if answered.
- output only the structured summary; NEVER extra text.
- keep sections concise.
- preserve relevant tool outputs/command results.
- include mentioned repository state changes (branch, uncommitted changes).

Format (omit inapplicable sections):

## Goal & Original User Intent
[Preserve the user's primary goal verbatim; add new goals if scope explicitly expanded. NEVER drop earlier root intent.]

## User Directives & Architectural Invariants
- [Preserve all existing user directives and project invariants; append newly confirmed constraints]

## Key Architectural Decisions
- **[Decision]**: [Preserve all previous technical decisions; append new rationales. Prevent semantic decay.]

## Modified Files & Artifacts
- [Cumulative list of exact file paths touched, created, or tested across all turns]

## Constraints & Preferences
- [Preserve existing constraints; append newly discovered parameters]
## Progress

### Done
- [x] [Include previously done and newly completed items]

### In Progress
- [ ] [Current work—update based on progress]

### Blocked
- [Current blockers—remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context; add new if needed]

## Additional Notes
[Other important info not fitting above]
