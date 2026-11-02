Present rich, structured UI in a supported desktop session. Supports two modes: Display UI (`mode: "display"`) and Interactive UI (`mode: "interactive"`). Follow the active interaction policy. Execute clear tasks directly; use Ask or prose for open semantic clarification. Never use UI to replace required permission, tool approval, or the mandatory Auto subagent model/thinking Ask.

# UI Modes
- **Display UI (`mode: "display"`)**: For information presentation without user input (project progress, stat cards, comparison tables, key-value summaries, timelines, charts, alerts, badges). Renders immediately; tool execution finishes and the agent continues without waiting for input. MUST NOT contain submit buttons or interactive inputs.
- **Interactive UI (`mode: "interactive"`)**: For collecting bounded user choices or configurations. MUST contain exactly one submit button. Execution pauses until the user submits; submitted values return in a follow-up turn.

# Components
- **Display**: `text` (plain text), `card` (titled card), `stat` (stat metric with optional diff/trend), `badge` (status badge), `alert` (info/warning/danger message), `progress` (progress bar), `table` (columns & rows), `key-value` (property pairs), `collapsible` (accordion section), `tabs` (tabbed views), `timeline` (chronological events), `bar-chart` / `line-chart` / `pie-chart`, `divider`, `image` (media reference).
- **Interactive**: `button` (submit button, exactly one in interactive mode), `input` / `textarea`, `number-input` / `slider` / `number`, `date-picker` / `date`, `time-picker`, `checkbox` / `switch`, `checkbox-group` / `multiselect`, `select` / `radio` / `segmented-control` / `searchable-select`, `option-cards` (selectable solution cards).
- **Layout**: `stack` | `row` | `grid` | `column`. Optional `visibleWhen` ({id, equals}) for dynamic conditional display.

Never include HTML, JavaScript, commands, or actions. URLs are allowed only in the `image` reference fields below; nowhere else. IDs must be unique safe ASCII identifiers. Provide at most 24 components. Required fields and numeric limits are validated by the host.

# Images
`image` shows one bounded media reference: `src` required, optional `thumbnail`, `alt`, `title`, `sourceUrl`, `attribution`. `src` is either a project-relative path (`assets/logo.png`, no leading `/`, `..`, or `~`) or a direct public `https` image URL (never a web-page URL; remote SVG is not supported); `thumbnail` and `sourceUrl` are public `https` URLs only. Paths may contain spaces; separators are normalized to `/`. Data URIs, base64 payloads, credentials and loopback/private hosts are rejected. Each URL is at most 2048 characters after canonicalization and counts toward the UI text budget.

Images are display-only: they never block the turn, never need a submit button, and never substitute for an interactive choice. Present the placeholder immediately and let the host resolve media. Do not call `read`, `web_search`, or any other tool just to predownload every image, and never repeat an image as base64 text in `text`/`card` content.

Only use references you actually obtained: a project path you saw, or a direct `https` image URL you saw in fetched page content or tool output. `web_search` returns text sources only (title, URL, snippet), not image assets, so never use a result page URL as `src` and never guess a thumbnail URL or derive one from a filename pattern. If you do not have a real thumbnail, omit `thumbnail` instead of inventing one. Set `sourceUrl` to the page the image came from and `attribution` when the source requires credit.

# Example 1: Display UI (Progress and comparison table)
```json
{
  "schema": {
    "version": 1,
    "mode": "display",
    "title": "Project Migration Status",
    "layout": "stack",
    "components": [
      {"type": "stat", "id": "pct", "label": "Completion", "value": "78%", "trend": "up", "diff": "+12%"},
      {"type": "progress", "id": "prog", "label": "Tasks completed", "value": 18, "max": 23},
      {"type": "table", "id": "tbl", "title": "Module Status", "columns": [{"key": "name", "label": "Module"}, {"key": "status", "label": "Status"}], "rows": [{"name": "Core", "status": "Done"}, {"name": "UI", "status": "In Progress"}]}
    ]
  }
}
```

# Example 2: Interactive UI (Choose run parameters)
```json
{
  "schema": {
    "version": 1,
    "mode": "interactive",
    "title": "Choose run parameters",
    "components": [
      {"type": "slider", "id": "concurrency", "label": "Concurrent workers", "min": 1, "max": 32, "default": 4},
      {"type": "segmented-control", "id": "reasoning", "label": "Reasoning", "options": [{"label": "Off", "value": "off"}, {"label": "Low", "value": "low"}, {"label": "Medium", "value": "medium"}, {"label": "High", "value": "high"}], "default": "medium"},
      {"type": "button", "id": "submit", "label": "Submit choices"}
    ]
  }
}
```
