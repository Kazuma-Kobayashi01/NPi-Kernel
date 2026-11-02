Update existing handoff summary in <previous-summary> tags from new messages above for another LLM to resume.

MUST:
- preserve all previous-summary information; add new progress, decisions, context.
- Progress: move completed "In Progress" items to "Done".
- update "Next Steps" for completed work.
- strictly preserve all LaTeX mathematical formulas (`$...$` and `$$...$$`) verbatim; NEVER abbreviate, skip derivation steps, or replace formulas with vague descriptive prose.
- strictly preserve all academic citations and literature identifiers (e.g., `\cite{...}`, author/year, ArXiv ID, DOI); NEVER drop citation keys.
- preserve exact file paths, function names, key configuration parameters, and error messages.
- strictly preserve all user directives, explicit long-term preferences, constraints, and user persona facts verbatim.
- MAY remove irrelevant content, but NEVER drop or dilute mathematical formulas, citations, file paths, or user constraints.
- If new messages end with an unanswered user question/request: add it to Critical Context; replace any previous pending question if answered.
- output only the structured summary; NEVER extra text.
- keep sections concise without sacrificing required verbatim details.
- preserve relevant tool outputs/command results.
- include mentioned repository state changes (branch, uncommitted changes).

Format (omit inapplicable sections):

## Goal & Original User Intent
[Preserve the user's primary goal verbatim; add new goals if scope explicitly expanded. NEVER drop earlier root intent.]

## User Directives & Architectural Invariants
- [Preserve all existing user directives, long-term preferences, user persona facts, and project invariants; append newly confirmed constraints]

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
- **Mathematical Derivations & Formulas**: ALL LaTeX mathematical formulas (`$...$` and `$$...$$`) MUST be preserved verbatim; NEVER abbreviate, skip derivation steps, or summarize in prose.
- **Academic Citations & Literature**: ALL literature identifiers (e.g., `\cite{...}`, author/year, ArXiv ID, DOI) MUST be strictly preserved without omitting citation keys.
- **Key Code State & File Paths**: Exact file paths, symbol/function names, configuration parameters, and error messages MUST be strictly preserved.
- **User Constraints & Persona Facts**: Explicit long-term preferences, constraints, and user persona facts MUST be preserved verbatim.

## Additional Notes
[Other important info not fitting above]
