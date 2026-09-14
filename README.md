# Jira Hierarchy Panel

A standalone Grafana panel for exploring **actual Jira parent trees alongside
observed ticket lifetimes**. Plugin ID: `easit-jira-panel`. Built and tested against
Grafana **13.0.1**, using public plugin APIs, React 18 and TypeScript. The repository's
older root-level Grafana 11 demo is not the plugin development environment.

## Features

- Parent-subtree focus or all-project browsing, including cross-project descendants.
- Expand/collapse and virtualized fixed-height rows. Only visible rows plus overscan are mounted.
- Search by key, summary, assignee, status or issue type. Multi-project filters retain ancestor context.
- Creation-to-resolution bars for resolved tickets; creation-to-last-observation bars for open tickets.
- Status-category colors, stale-observation markers, detail drawer and safe links to Jira.
- Local zoom, pan and fit-to-tickets. Collapsing rows does not change the fitted time extent.
- Missing parents remain visible as roots. Cyclic relationships are broken with a warning.
- Light/dark Grafana themes, keyboard-operable controls, and horizontal scrolling on narrow screens.

The timeline does **not** represent planned dates, status transitions, dependencies,
or Jira changes that happened after the last observation. Parent bars show the
parent issue's own lifetime, not a synthetic roll-up of its children.

## Run The Playground

Requirements: Node 22+, npm, Docker with Compose. From `grafana-panel/`:

```sh
npm ci
npm run build
docker compose --env-file /dev/null -p jira-panel-dev -f docker-compose.dev.yml up -d --wait
npm run seed
```

Both npm and pnpm work without Git or SSH configuration. The package override maps
Grafana UI's transitive Git-only `react-data-grid` dependency to registry release
`7.0.0-beta.61`, the current registry line compatible with the Grafana UI dependency.
For pnpm, this override is in `pnpm-workspace.yaml` because pnpm 11 no longer reads
the legacy `pnpm` package.json field.
Use either:

```sh
npm ci
# or
pnpm install --frozen-lockfile
```

The build uses Grafana/React as external runtime modules, not bundled copies of
these SDK dependencies. Do not remove the `react-data-grid` override unless the
Grafana SDK releases a registry-resolvable dependency.

Open [Jira Hierarchy - Development](http://127.0.0.1:3300/d/jira-hierarchy-dev), in
the **Operations** folder. Grafana is loopback-only on port 3300; VictoriaLogs is
loopback-only on 19428. These services have separate storage and never load the
repository `.env`, contact Jira, or connect to the existing Grafana instance.

The fixture contains 3,832 synthetic tickets. Enter `PM-100` for a small cross-project
tree, `PM-200` for maintenance work, or `PM-300` for 3,757 tickets. Clear Parent to
see all trees, including missing-parent examples. No real Jira data is seeded.

Anonymous viewing is enabled. For editing, the deliberately development-only
login is `jira-panel-dev` / `jira-panel-development-only`. **Do not expose this
stack through a public interface, proxy or tunnel.** See [development notes](dev/README.md)
for ports, fixture details, and stop/reset commands.

For iterative changes, run `npm run dev` and reload the dashboard after compilation.
Build `dist/` before starting Compose, so Docker does not create it as root.

## Query Contract

Use the enriched exporter's `issue_state` heartbeats. The exporter now emits
`summary`, `issue_type`, `parent_key`, `resolved_at` and `is_resolved` on each sync,
in addition to its existing state fields. **Deploy the updated exporter and let
a complete sync finish before pointing the panel at existing data.** No state-file
reset or snapshot backfill is needed, since unchanged issues still emit heartbeats.

The panel accepts flat table DataFrames or native VictoriaLogs frames with a
per-row `labels` object. The development dashboard uses Grafana's Extract fields
transformation (`labels`, JSON, replace all) to demonstrate a flat table.

| Field | Meaning |
| --- | --- |
| `issue_key` | Required ticket identity |
| `app`, `instance`, `environment` | Source namespace; retain through queries and transformations |
| `created_at` | Required ISO 8601 creation time, or numeric epoch milliseconds |
| `sync_ts` | Observation time; falls back to `_time` or Grafana's `Time` field |
| `is_resolved` | Required boolean or string `"true"` / `"false"`; not inferred from status |
| `resolved_at` | Required valid timestamp if resolved; ignored if open/reopened |
| `parent_key` | Actual Jira parent; absent or empty for roots |
| `project_key`, `summary`, `issue_type` | Project filtering and display metadata |
| `status`, `status_category` | Label and color (`new`, `indeterminate`, `done`) |
| `assignee`, `priority` | Search/detail metadata |

Example LogsQL, with a source selector adjusted for your exporter:

```logsql
{app="jira-exporter", instance="demo", environment="development"} kind:="issue_state"
| stats by (app, instance, environment, issue_key) row_max(_time) as row
| unpack_json from row
| fields _time, sync_ts, app, instance, environment, issue_key, project_key, summary, issue_type, parent_key, created_at, resolved_at, is_resolved, status, status_category, priority, assignee
| sort by (issue_key)
| limit 10001
```

Use the VictoriaLogs **instant/logs** query type (`queryType: "instant"`), not a
time-series aggregation. Set the query and datasource line limits to at least
`maxIssues + 1`. The example pairs `maxLines: 10001` with panel `maxIssues: 10000`.
The extra row allows the panel to warn that a tree may be incomplete. A lower
datasource limit cannot be detected reliably by the panel. Development pins
datasource version **0.26.3**, verified to pass the 10,001-row limit through.

Include the parent and **every descendant project** in the query. Filtering to the
parent's project before fetching would discard cross-project children. Use the
panel's project filters to preserve ancestor context. For very large Jira datasets,
scope the query to a complete set of relevant projects rather than silently
truncating. The panel caps displayed issues at 50,000 even if configured higher.

The time picker selects **observations**, not creation dates. Choose a lookback
longer than the sync interval plus the duration of a full sync and any expected
outages. The development panel overrides this to 30 days; it then fits the full
lifetimes of the returned tickets. Local timeline zoom never changes the query.
Absolute Grafana time ranges disable relative panel overrides.

## Panel Options

| Option | Default | Purpose |
| --- | --- | --- |
| Parent ticket | Empty | Initial root key, supports dashboard variables; empty shows all trees |
| Jira base URL | Empty | Enables `/browse/<key>` links; allows HTTP(S) and Jira context paths only |
| Initially expanded levels | 2 | Expand the root and its direct children on initial display |
| Stale after (hours) | 24 | Mark each ticket whose last observation is older than this threshold |
| Maximum issues | 10,000 | Cap with a visible warning when an extra issue is returned |
| Row height | 36px | Fixed row size used for virtualization |
| Ticket column width | 420px | Width of the hierarchy column; bounded to retain a timeline |

Toolbar changes are local, not saved dashboard settings. Configure the initial
Parent in panel options to persist it, or use a dashboard variable there. Manually
entering a key matches that key in all returned source namespaces. **Focus subtree**
in a ticket's details retains its source identity. Relationships never cross source
namespaces. A single panel has one Jira base URL; scope to a single Jira site when
using links across exporters from different sites.

## Validation

```sh
npm run build
npm test
npx playwright install chromium
npm run test:e2e
# Equivalent pnpm commands: pnpm build, pnpm test, pnpm exec playwright install chromium, pnpm test:e2e
```

Browser tests require the running, seeded development stack. They exercise the
real Grafana plugin loader and VictoriaLogs query, hierarchy controls, reopened
tickets, multi-project ancestor context, thousands of virtualized rows, mobile
details, light/dark rendering and query-independent zoom. Images are written to
the ignored `test-results/` directory. Unit tests cover malformed rows, deduplication,
source isolation, missing/cyclic parents, a 10,000-level tree, time clipping and URL safety.

To test the exporter from the repository root:

```sh
go test ./cmd/... ./internal/...
```

The pinned Grafana 13.0.1 development SDK has upstream transitive dependency audit
advisories. It is externalized from the plugin bundle; the host supplies Grafana,
React and Emotion. Keep the host Grafana patched before production use and review
`npm audit` when updating the SDK. Do not apply force upgrades blindly against a
different host API version. No development test server is exposed by the build.

## Deployment And Limits

`npm run build` produces `dist/module.js`, `plugin.json`, the logo and this README.
Install the **contents of `dist/`** in a Grafana plugin directory named
`easit-jira-panel`. On a self-hosted development instance, allow only that unsigned
ID via `GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS=easit-jira-panel` and restart
Grafana. Production distribution requires your approved signing/install process;
this repository does not include a signing key or a signed release.

Add a Jira Hierarchy panel using your VictoriaLogs datasource and the query above.
Any new dashboard for this project should live in **Operations**. The development
dashboard is not directly portable without changing its datasource UID, demo
source selector and Jira URL. Existing shared dashboards were not modified.

This is a latest-observation view, not an authoritative current-membership database.
Deleted, moved, permission-hidden or JQL-excluded tickets can remain visible until
they fall outside the query window. A partially failed sync can leave observation
times mixed across tickets. Freshness is shown per ticket; no completeness claim
is inferred from the newest timestamp. Missing or invalid rows and known cap
truncation are explicitly reported, but unseen data cannot be reconstructed.

The untracked `references/core-traces-panel/` and `references/grafana-gantt-panel/`
inspired the layout and interactions. Their source was not copied. The panel does
not import Grafana-internal TraceView modules, encode Jira as spans, or require a
trace backend.
