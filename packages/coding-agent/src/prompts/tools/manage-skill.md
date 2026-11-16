Managed skill: `SKILL.md` surfaced as a normal skill in future sessions.

Use: repeatable procedures worth codifying — setup sequence, debugging recipe, project-specific workflow.
User-authored skills separate; tool NEVER edits them.

`scope`: `project` (default) writes `<project>/.npi/skills`, used only in this project. `global` writes `~/.omp/agent/managed-skills`, used in every project; set it ONLY when the user explicitly asked for a global skill, or after you asked and they chose global. Unsure which? Ask; NEVER pick global yourself. `update`/`delete` act on the same `scope`; an existing global skill needs `scope: "global"`.

- `action: "create"` — fails if skill exists.
- `action: "update"` — overwrites body; fails if skill absent.
- `action: "delete"` — fails if skill absent.

`name`: kebab-case (lowercase letters, digits, hyphens).
`description`: specific; drives discovery.
No frontmatter in `body`; generated from `name` and `description`.
