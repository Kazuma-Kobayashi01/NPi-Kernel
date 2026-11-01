You MUST summarize the conversation above into a structured handoff summary for another LLM to resume the task.

IMPORTANT: If the conversation ends with an unanswered question or a request awaiting user response (e.g., "Please run command and paste output"), you MUST preserve that exact question/request.

You MUST use this format (sections can be omitted if not applicable):

## Goal & Original User Intent
[Preserve the user's primary goal verbatim; list multiple if session covers different tasks. NEVER drop or dilute the original task request.]

## User Directives & Architectural Invariants
- [Explicit project constraints, branch rules, coding paradigms, forbidden actions, or engineering boundaries specified by the user]

## Key Architectural Decisions
- **[Decision]**: [Technical choice and exact rationale. Preserve permanent invariants across compactions.]

## Modified Files & Artifacts
- [Exact file paths modified, created, or tested, including branch state and key exports/APIs]

## Constraints & Preferences
- [Constraints or technical conventions discovered during execution]
## Progress

### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of next actions]

## Critical Context
- [Important data, pending questions, references]

## Additional Notes
[Anything else important not covered above]

You MUST output only the structured summary; you NEVER include extra text.

Sections MUST be kept concise. You MUST preserve exact file paths, function names, error messages, and relevant tool outputs or command results. You MUST include repository state changes (branch, uncommitted changes) if mentioned.
