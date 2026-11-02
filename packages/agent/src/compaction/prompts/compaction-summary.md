You MUST summarize the conversation above into a structured handoff summary for another LLM to resume the task.

IMPORTANT: If the conversation ends with an unanswered question or a request awaiting user response (e.g., "Please run command and paste output"), you MUST preserve that exact question/request.

You MUST use this format (sections can be omitted if not applicable):

## Goal & Original User Intent
[Preserve the user's primary goal verbatim; list multiple if session covers different tasks. NEVER drop or dilute the original task request.]

## User Directives & Architectural Invariants
- [Explicit project constraints, branch rules, coding paradigms, forbidden actions, engineering boundaries, long-term preferences, or user persona facts specified by the user]

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
- **Mathematical Derivations & Formulas**: ALL LaTeX mathematical formulas (`$...$` and `$$...$$`) MUST be preserved verbatim; NEVER abbreviate, skip derivation steps, or replace formulas with vague descriptive prose.
- **Academic Citations & Literature Sources**: ALL literature identifiers (e.g., `\cite{...}`, author/year, ArXiv IDs, DOIs) MUST be strictly preserved without omitting citation keys or bibliographic references.
- **Key Code State & File Paths**: Exact file paths, symbol/function names, key configuration parameters, and error messages MUST be strictly preserved.
- **User Directives & Invariants**: User explicitly declared long-term preferences, constraints, architectural boundaries, and persona facts MUST be preserved verbatim.

## Additional Notes
[Anything else important not covered above]

You MUST output only the structured summary; you NEVER include extra text.

Sections MUST be kept concise, but conciseness NEVER overrides verbatim preservation:
- Mathematical derivations and formulas: ALL LaTeX mathematical formulas (`$...$` and `$$...$$`) MUST be preserved verbatim; NEVER abbreviate, skip derivation steps, or vaguely summarize in prose.
- Academic citations and sources: ALL literature identifiers (`\cite{...}`, author/year, ArXiv ID, DOI) MUST be strictly preserved; NEVER drop or omit citation keys.
- Key code state and file paths: You MUST preserve exact file paths, function/type names, key configuration parameters, error messages, and relevant tool outputs or command results.
- User directives and facts: You MUST strictly preserve user long-term preferences, constraints, architectural invariants, and explicitly declared persona facts.
- Repository and execution state: You MUST include repository state changes (branch, uncommitted changes) if mentioned.
