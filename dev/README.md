# Isolated Panel Development

**DEVELOPMENT ONLY: Grafana allows anonymous viewing and uses a fixed local admin. Both published ports
must remain bound to loopback. Never expose this stack through a reverse proxy,
tunnel, or public interface. Any local user can administer it.**

This is a separate Compose project, `jira-panel-dev`, with its own default network
and named volumes. It has only Grafana and VictoriaLogs: no exporter, Jira access,
external datasources, shared storage, repository `.env`, or secret mounts. The
only expected external connection is downloading the pinned signed datasource
plugin at initial Grafana startup. Images must also be available locally or pulled.
Restart policies are disabled.

## Commands

Run from `grafana-panel/` after the main build has produced `dist/plugin.json` and
the plugin bundle. These commands are intentionally explicit about the Compose
file, project name, and empty environment file. Do not combine with the repository
root Compose file. Do not source the repository `.env`.

```sh
docker compose --env-file /dev/null -p jira-panel-dev -f docker-compose.dev.yml config
docker compose --env-file /dev/null -p jira-panel-dev -f docker-compose.dev.yml up -d --wait
node dev/seed.mjs
```

Open <http://127.0.0.1:3300/d/jira-hierarchy-dev>. The provisioned folder is
`Operations` (`jira-panel-dev-operations`). No login is needed. The deliberately
non-secret local bootstrap account is `jira-panel-dev` /
`jira-panel-development-only`; use it to edit panel options. Anonymous access is Viewer.
Host `GF_SECURITY_ADMIN_*` variables are not passed through to the container.
Only `easit-jira-panel` is allowed to load unsigned.

After code changes, rebuild and restart Grafana so it reads the new bundle-specific
plugin version, then reload the browser page (not just Grafana's **Refresh** button):

```sh
npm run build
docker compose --env-file /dev/null -p jira-panel-dev -f docker-compose.dev.yml restart grafana
docker compose --env-file /dev/null -p jira-panel-dev -f docker-compose.dev.yml up -d --wait
```

No reseeding is needed for code-only changes. The current UI includes **Depth**,
**CSV**, **JSON**, child-count badges, and a `blocks` arrow between `PM-100` and
`OPS-900003`. Missing all of these indicates an older plugin bundle is still loaded.

Custom loopback ports (set both Compose's logs port and the seeder URL explicitly):

```sh
PANEL_GRAFANA_PORT=3301 PANEL_LOGS_PORT=19429 docker compose --env-file /dev/null -p jira-panel-dev -f docker-compose.dev.yml up -d --wait
VL_DEV_URL=http://127.0.0.1:19429 node dev/seed.mjs
```

`VL_DEV_URL` accepts only an HTTP origin at `127.0.0.1`, `localhost`, or `[::1]`,
without credentials, path, query, or fragment. Redirects are rejected. Point it
only at this development instance; the script does not inspect other services.
The default Compose binding is IPv4, so prefer `127.0.0.1`.

Offline fixture inspection with Node 22+ (NDJSON to stdout, no HTTP request):

```sh
node dev/seed.mjs --dry-run
```

Stop just this project, preserving its seed data:

```sh
docker compose --env-file /dev/null -p jira-panel-dev -f docker-compose.dev.yml down
```

For a clean fixture reset, append `--volumes` to that command. This deletes only
this project's development volumes, including Grafana's local state. Then start
and seed again. Nothing in this directory starts or restarts the repository stack.

## Fixtures

The dependency-free Node 22 script uses native `fetch` to post batches of 500
NDJSON observations to `/insert/jsonline`. All records use stream fields
`app=jira-exporter`, `instance=demo`, `environment=development`. All names and
summaries are synthetic; Jira links use the reserved `jira.example.invalid` domain.

- `PM-100`: 6 epics, 36 stories, 18 subtasks, and a reopened bug. Stories and subtasks span PM, OPS, and REL projects.
- `PM-200`: 3 maintenance tasks and 6 subtasks, independent of PM-100.
- `PM-300`: 12 epics, 288 stories, and 3,456 subtasks: 3,756 descendants over three levels below the root.
- `OPS-900001` and `REL-900002`: missing parents; `REL-900001` is a child of the first orphan.
- Stale observations are three days old, beyond `staleHours=24` but within the 30-day query window.
- `OPS-900003`: a seven-day-old resolved revision followed by the latest reopened state, with no `resolved_at` on the latest row.
- Every 17th issue has an older revision; PM-100 also has an exact duplicate. Older revisions are ingested after current rows to test timestamp-based selection rather than arrival order.
- PM-100 includes synthetic `blocks` and `clones` relationships; the first two multi-child workstreams also have `blocks`, `relates to`, `duplicates`, and `clones` links for arrow routing.

Keys, relationships, status choices, and relative dates are deterministic. Each
run captures one current clock anchor; normal heartbeats are one minute old and
creation dates span the 180-day timeline. Re-running appends observations, not
new issue identities. Latest-per-source-and-ticket selection deduplicates them.
Fresh data eventually becomes stale without re-seeding; there is no background
exporter. Use a clean volume for exact reproducibility across runs separated by
days, since a previously fresh observation may then outrank an intentionally old
fixture revision.

The normal dataset is below 10,000 issues. To exercise the cap warning without
creating a larger fixture, temporarily reduce panel `maxIssues` in the editor;
provisioning remains at 10,000. Change `rootKey` to PM-200 or PM-300 to inspect the
other trees. UI edits are temporary; persist intended changes in the JSON file.

## Query And Schema

The dashboard is classic schema (`panels[]`, `schemaVersion: 39`), not the v2
`elements` format used by the repository's other dashboards. Its single panel is
ID 1, type `easit-jira-panel`, datasource UID `jira-dev-logs`. Options match the
panel contract: `rootKey=PM-100`, `initialDepth=2`, `staleHours=24`,
`jiraBaseUrl=https://jira.example.invalid`, `maxIssues=10000`, `rowHeight=36`,
`labelWidth=420`.

Each heartbeat has these fields:

| Field | Seed representation / meaning |
| --- | --- |
| `_time`, `sync_ts` | UTC ISO 8601 observation timestamps, not creation timestamps |
| `kind` | `issue_state` |
| `app`, `instance`, `environment` | Mandatory source identity, retained through aggregation and projection |
| `issue_key`, `project_key` | Synthetic Jira-style keys |
| `summary`, `issue_type` | Display text and Initiative/Epic/Story/Task/Sub-task/Bug |
| `parent_key` | Optional; absent on roots, deliberately missing targets on orphans |
| `created_at` | UTC ISO 8601 creation time for timeline placement |
| `resolved_at` | Optional UTC ISO 8601 resolution time; absent on open/reopened issues |
| `is_resolved` | JSON boolean on ingestion; VictoriaLogs may return it as a string |
| `status`, `status_category` | Display status; category `new`, `indeterminate`, or `done` |
| `priority`, `assignee` | Display strings; empty assignee means unassigned |
| `issue_links` | Optional normalized relationship array with target key, canonical type, current-side display label, and inward/outward direction |

The insertion request also supplies `_msg` as a copy of `summary`, leaving the
mandatory `summary` field intact. The query retains all contract fields:

```text
{app="jira-exporter", instance="demo", environment="development"} kind:="issue_state"
| stats by (app, instance, environment, issue_key) row_max(_time) as row
| unpack_json from row
| fields _time, sync_ts, kind, app, instance, environment, issue_key, project_key, summary, issue_type, parent_key, issue_links, created_at, resolved_at, is_resolved, status, status_category, priority, assignee
| sort by (issue_key)
| limit 10001
```

No project or root filter is applied before aggregation: cross-project descendants
and missing-parent cases must reach the panel. The final limit and target
`maxLines: 10001` preserve one row beyond `maxIssues: 10000` as a warning sentinel.
The datasource-wide `jsonData.maxLines` is also `"10001"`.

Target validation references:

- Repository `grafana/dashboards/jira-issue-explorer.json`, latest-state table: uses `expr`, `queryType: "instant"`, and `extractFields` on `labels`. The development dashboard uses the same transformation to expose named columns to the panel.
- [Public catalog versions](https://grafana.com/api/plugins/victoriametrics-logs-datasource/versions): confirms signed catalog version `0.26.3`, requiring Grafana >=10.4.0.
- [Pinned target types](https://github.com/VictoriaMetrics/victorialogs-datasource/blob/v0.26.3/src/types.ts): `queryType: "instant"` selects raw `/select/logsql/query`, not a stats query; target `maxLines` is numeric, datasource `maxLines` is a string.
- [Pinned frontend](https://github.com/VictoriaMetrics/victorialogs-datasource/blob/v0.26.3/src/datasource.ts) and [backend](https://github.com/VictoriaMetrics/victorialogs-datasource/blob/v0.26.3/pkg/plugin/query.go): pass the explicit line limit through without a 10,000 clamp. The newer catalog release documents a 10,000 cap, so do not upgrade without checking sentinel behavior.

The panel has `timeFrom: "30d"`, while the dashboard defaults to `now-180d` through
`now`. The panel fits the fetched tickets' full lifetimes, independently of the
observation query window. Its zoom and pan controls are local and do not requery.
Grafana relative panel overrides do not apply when an absolute dashboard time
range is selected; that absolute range then selects observations, not creation dates.

Grafana installs the pinned datasource synchronously (`preinstall_async=false`)
before serving. Its healthcheck covers `/api/health`; it is not proof that the
plugin bundle renders or that the seeded query returns the expected fields.
Run `npm run test:e2e` after building and seeding to verify actual queries and
rendering in a browser. Default unrelated plugin preinstalls and automatic plugin
updates are disabled so the stack only downloads the pinned datasource.
