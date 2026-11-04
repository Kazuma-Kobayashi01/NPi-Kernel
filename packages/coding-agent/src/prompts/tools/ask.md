Fallback question channel. When `ui.present` exists in this session, do NOT call this tool for decisions: present Interactive UI instead, so options, defaults, ranges, and several fields arrive in one submission.

<instruction>
- Use only when this surface has no `ui.present`, or for one free-form question that a form cannot express.
- Batch related questions; ask only implementation-relevant ones; never repeat decisions already given.
- Present findings, scope, risks, and the recommendation before asking.
- Never use this tool to request approval for a sensitive or destructive action; that belongs to the native permission gate.
- Wait before dependent changes. A timeout or auto-selected answer is not explicit approval of substantial scope.
</instruction>
