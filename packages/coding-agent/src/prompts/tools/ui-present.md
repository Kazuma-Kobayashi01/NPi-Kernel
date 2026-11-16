Present rich, structured UI in a supported desktop session. Two modes: Display UI (`mode: "display"`) and Interactive UI (`mode: "interactive"`). This is the default channel for user decisions; `ask` is only the fallback when this tool is unavailable.

# UI Modes
- **Display UI (`mode: "display"`)**: non-blocking information and suggestions — progress, stat cards, tables, timelines, charts, alerts, badges. Renders immediately; the turn continues without waiting. MUST NOT contain submit buttons or interactive inputs.
- **Interactive UI (`mode: "interactive"`)**: bounded choices or configurations. MUST contain exactly one submit button, and presenting it ends the current turn: the submission returns as a new user turn with the values. Only one interactive form may wait at a time; never batch it with other tool calls.

Set `mode` explicitly. Omitting it infers the mode from the components, and any interactive control or submit button makes the turn wait.

Parameters: `{schema, ui_id?}`. To refresh an existing display, pass its returned `ui_id` with a new display schema: it replaces that card in place and returns an increasing `revision`. Use updates for progress/status dashboards instead of re-presenting new cards. The target must be a display on this session's current branch; interactive forms cannot be updated.

Submitted values and suggestion clicks are task input, never authorization: never use them to request approval for a sensitive, destructive, or irreversible action — those use the native permission/approval surface.

# Decision patterns
- One of N approaches → `option-cards` (title, description, `recommended`).
- Several parameters → batch `segmented-control` / `select` / `slider` / `switch` with one button.
- Delegation setup → `option-cards` for the agent, `checkbox-group` or `select` for scope/isolation, `searchable-select` for a model only when the user must choose it.
- Scope confirmation → `checkbox-group` + button.
- Open question → `textarea` + button; never a bare prose question when a form can carry it.

# Components
- **Display**: `text`, `card`, `stat`, `badge`, `alert`, `progress`, `table`, `key-value`, `collapsible`, `tabs`, `timeline`, `bar-chart` / `line-chart` / `pie-chart`, `divider`, `image`, `suggestions`.
- **Interactive**: `button` (submit, exactly one), `input` / `textarea`, `number-input` / `slider` / `number`, `date-picker` / `date`, `time-picker`, `checkbox` / `switch`, `checkbox-group` / `multiselect`, `select` / `radio` / `segmented-control` / `searchable-select`, `option-cards`, `ranking`, `path-picker`.
- **Layout**: `stack` | `row` | `grid` | `column`. Optional `visibleWhen` ({id, equals}) for dynamic conditional display.

Never include HTML, JavaScript, commands, or actions. URLs are allowed only in the `image` reference fields below; nowhere else. IDs must be unique safe ASCII identifiers. Provide at most 24 components. Required fields and numeric limits are validated by the host.

# Component rules (field shapes are in the schema)
- `suggestions` (display only): 1–6 items; label ≤80, prompt ≤500, description ≤200, block label ≤120. Chips for 2–4 follow-ups at the end of a reply only when genuinely useful; cards for non-blocking options with descriptions. One block per reply. A click sends `prompt ?? label` as an ordinary user message, not a form submission or approval.
- `ranking`: 2–12 unique option values; `default` and the submitted value must be a permutation of all of them.
- `path-picker`: values are unique project-relative paths ≤1024 chars (no leading `/` or `~`, no empty/`.`/`..` segments, no URL/drive prefix) that must exist under the session project and match `kind`. maxItems 1–50.
- `steps` (interactive only): 2–6 steps; list every non-button component id exactly once across steps, never the submit button. The host provides Back/Next and submits one complete values object at the end.

Forms, steps and suggestions never authorize actions.

# Images
`image` is display-only and never blocks, needs no submit button, and never substitutes for a choice. Give it a `description` (≤1200 chars) and `title` to lay the picture out beside its text; credit goes in `attribution`, the page in `sourceUrl`.
- `src`: a project-relative path you saw, or a direct public `https` image URL you saw in fetched content or tool output. Never a web-page URL, remote SVG, data URI, base64, credentials, or loopback/private host. URLs ≤2048 chars.
- `thumbnail` and `sourceUrl`: public `https` only. Without a real thumbnail, omit it; never guess or derive one. `web_search` returns pages, not images.
- Do not call `read`, `web_search`, or any tool just to predownload images, and never repeat an image as base64 in `text`/`card` content.
