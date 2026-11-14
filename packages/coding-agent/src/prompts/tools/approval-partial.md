The user approved only selected hunks of this proposal (zero-based indices).
Applied hunks: {{applied}}.
Rejected hunks: {{rejected}}.
Only the applied hunks were written. The rejected changes were NOT applied. Do not assume the original full edit landed, and do not reapply rejected changes without a new user instruction. Re-read affected files before making further edits.

{{#each hunks}}
Hunk {{index}} ({{status}}): {{{path}}}
{{{header}}}
{{#each lines}}
{{{this}}}
{{/each}}
{{/each}}
