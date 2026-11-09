# Build editions (`global` and `cn`)

`omp` compiles one of two editions from the same source and the same model catalogue:

| Edition | Build flag | Hides |
|---|---|---|
| `global` (default) | none | nothing |
| `cn` | `NPI_EDITION=cn` | the international-site provider ids of mainland-China vendors |

The `cn` edition exists so a China-region release does not point users at a mainland vendor's
international site by default. **Nothing is deleted**: `packages/catalog/src/models.json` keeps
every provider and model, and the hidden ids remain selectable again in a `global` build.

## Hidden in the `cn` edition

Each id below is a mainland-China vendor whose bundled endpoint is the vendor's international
(offshore) site. The same vendor's China-region endpoint stays available through the listed
China-region id.

| Hidden provider id | Bundled endpoint (international) | China-region alternative kept |
|---|---|---|
| `alibaba` | `dashscope-intl.aliyuncs.com` (Singapore) | `alibaba-cn` |
| `qwen-portal` | `portal.qwen.ai` (Singapore) | `alibaba-cn` |
| `siliconflow` | `api.siliconflow.com` (US) | `siliconflow-cn` |
| `zai` | `api.z.ai` | `zhipu-coding-plan` |
| `minimax` | `api.minimax.io` | `minimax-cn` |
| `minimax-code` | `api.minimax.io` | `minimax-code-cn` |
| `xiaomi-token-plan-sgp` | `token-plan-sgp.xiaomimimo.com` | `xiaomi-token-plan-cn` |
| `xiaomi-token-plan-ams` | `token-plan-ams.xiaomimimo.com` | `xiaomi-token-plan-cn` |

Deliberately **not** hidden, with the reason:

- `deepseek`, `qianfan`, `kimi-code`, `zhipu-coding-plan`, `alibaba-cn`, `siliconflow-cn`,
  `minimax-cn`, `minimax-code-cn`, `xiaomi-token-plan-cn`: these already are China-region
  endpoints.
- `moonshot`, `stepfun`: no separate China-region id exists in the catalogue, so hiding the id
  would remove the vendor entirely. `moonshot` can be pointed at its China-region host with
  `MOONSHOT_BASE_URL`; the bundled default remains the international host.
- `alibaba-coding-plan`, `alibaba-token-plan`, `xiaomi`: one id carries both regions (the login
  flow stores the China-region URL in the credential), so hiding it would also remove the
  China-region path.

## How the block works

- `config/edition.ts` holds `EDITION` (from the compile-time `PI_EDITION`) and
  `EDITION_HIDDEN_PROVIDERS`.
- `disabledProviders` defaults to that list, so fresh installs never see the ids.
- `withEditionHiddenProviders()` unions the list at every read site (model registry availability
  and discovery, CLI/role resolution, capability discovery, setup wizard, `/login`, model hub,
  session scoped models, subagent fallback chains, SDK, auth gateway), so a saved
  `disabledProviders` — including `[]` — cannot lift it. The union is the enforcement; the
  default is only the visible surface.
- Upgrading a `cn` install to `global` (or the reverse) invalidates the model cache through the
  existing settings revision, so no manual cache cleanup is needed.

Users cannot re-enable a hidden id inside a `cn` build; they can use the China-region id, a
`models.yml` custom provider, or install the `global` build.

## Verifying an edition

```sh
npi config get disabledProviders --json   # cn: lists the hidden ids, global: []
npi models ls                             # a hidden id yields no rows even with its key set
```

## Building

```sh
cd packages/coding-agent && NPI_EDITION=cn CROSS_TARGET=linux-x64 bun scripts/build-binary.ts
```

`NPI_EDITION` is substituted at compile time (`process.env.PI_EDITION`), so a runtime environment
variable of the same name has no effect on a compiled binary.
