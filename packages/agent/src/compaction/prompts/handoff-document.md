<critical>
Write a handoff document for another instance of yourself.
The handoff MUST be sufficient for seamless continuation without access to this conversation.
Output ONLY the handoff document. No preamble, no commentary, no wrapper text.
</critical>

<instruction>
Capture exact technical state, not abstractions.
- File paths, symbol names, key configuration parameters, commands run
- Test results, observed failures
- Decisions made
- Partial work affecting the next step
- Mathematical derivations & formulas: all LaTeX formulas (`$...$` and `$$...$$`) MUST be preserved verbatim; NEVER abbreviate, skip derivation steps, or summarize in prose
- Academic citations & sources: all literature identifiers (e.g., `\cite{...}`, author/year, ArXiv ID, DOI) MUST be strictly preserved without dropping citation keys
- User directives & persona facts: explicit long-term preferences, constraints, and persona facts MUST be preserved verbatim
Register: address the successor directly in the imperative ("Fix X", "Run Y") — never first person ("I need to…", "my attempt…").
The handoff mechanism is invisible to the document: NEVER list writing, generating, or delivering a handoff/summary/context document as progress or a next step. Progress and Next Steps cover the user's task only.
</instruction>

<output>
Use exactly this structure:

## Goal
[What the user is trying to accomplish]

## Constraints & Preferences
- [Any constraints, long-term preferences, requirements, or explicitly declared user persona facts]

## Progress
### Done
- [x] [Completed tasks with specifics]

### In Progress
- [ ] [Current work if any]

### Pending
- [ ] [Tasks mentioned but not started]

## Key Decisions
- **[Decision]**: [Rationale]

## Critical Context
- Code snippets, file paths, function/type names, key configuration parameters, error messages, data essential to continue
- Mathematical derivations & formulas: all LaTeX formulas (`$...$` and `$$...$$`) preserved verbatim without abbreviation or step skipping
- Academic citations & literature: all literature identifiers (`\cite{...}`, author/year, ArXiv ID, DOI) preserved with full citation keys
- User constraints, long-term preferences, and persona facts preserved verbatim
- Repository state if relevant

## Next Steps
1. [What should happen next]
</output>

{{#if additionalFocus}}
<instruction>
Additional focus: {{additionalFocus}}
</instruction>
{{/if}}
