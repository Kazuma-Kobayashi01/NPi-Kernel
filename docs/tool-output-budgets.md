# Tool output budgets

The default tool-result policy keeps small results inline and stores large results in artifacts for selective follow-up reads. These are UTF-8 byte budgets, not token counts; token savings depend on the content and model.

| Setting | Default |
| --- | --- |
| `tools.artifactSpillThreshold` | 12 KiB |
| `tools.artifactHeadBytes` | 2 KiB |
| `tools.artifactTailBytes` | 6 KiB |
| `tools.artifactTailLines` | 100 lines |
| `read.defaultLimit` | 120 lines |

The settings above use KiB units for their numeric byte-size values. Previously the defaults were 50, 20, 20, 500 and 300 respectively. Explicitly configured values continue to take precedence.

`tools/output-meta.ts` saves oversized ordinary tool results and returns a head/tail preview with an artifact reference. Streaming output uses its existing OutputSink budget and final byte-cap protection, including notice slack; not every result has an exact 8 KiB size. Artifact storage retains its existing 16 MiB default cap and existing overflow policy.

File reads use line-boundary paging and return a continuation notice. Explicit ranges and configured larger page sizes remain supported, subject to the existing byte and line safety limits. Edit snapshots retain original file contents rather than the displayed truncation.

This change does not adjust delegation, reasoning effort, completion probes, widget model calls or user configuration files. Tests cover a medium result that now spills, recovery of its elided middle through `artifact://`, explicit larger budgets, default file paging, explicit ranges and configured page sizes.
