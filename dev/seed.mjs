#!/usr/bin/env node

// Node 22+, no dependencies, no Jira access, and no environment-file loading.
const dryRun = process.argv.includes('--dry-run');
if (process.argv.slice(2).some((arg) => arg !== '--dry-run')) {
  console.error('Usage: node dev/seed.mjs [--dry-run]');
  process.exit(1);
}

try {
  const base = new URL(process.env.VL_DEV_URL || 'http://127.0.0.1:19428');
  if (
    base.protocol !== 'http:' ||
    !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname) ||
    base.username || base.password || base.pathname !== '/' || base.search || base.hash
  ) {
    throw new Error('VL_DEV_URL must be an HTTP loopback origin without credentials, path, query, or fragment.');
  }

  // One clock anchor; keys, relationships, statuses, and relative dates are deterministic.
  const now = Date.now();
  const hour = 60 * 60 * 1000;
  const daysAgo = (days) => new Date(now - days * 24 * hour).toISOString();
  const source = { app: 'jira-exporter', instance: 'demo', environment: 'development' };
  const issues = [];
  const nextKey = { PM: 1000, OPS: 1000, REL: 1000 };

  function addIssue(project, parent, summary, type, ageDays, options = {}) {
    const index = issues.length;
    const resolved = options.resolved ?? (index % 4 === 0);
    const observed = daysAgo(options.stale ? 3 : 1 / 1440);
    const issue = {
      ...source,
      _time: observed,
      sync_ts: observed,
      kind: 'issue_state',
      issue_key: options.key ?? `${project}-${nextKey[project]++}`,
      project_key: project,
      summary,
      issue_type: type,
      ...(parent ? { parent_key: parent } : {}),
      created_at: daysAgo(ageDays),
      ...(resolved ? { resolved_at: daysAgo(Math.max(4, ageDays / 3)) } : {}),
      is_resolved: resolved,
      status: resolved ? 'Done' : index % 3 === 0 ? 'To Do' : 'In Progress',
      status_category: resolved ? 'done' : index % 3 === 0 ? 'new' : 'indeterminate',
      priority: ['Highest', 'High', 'Medium', 'Low'][index % 4],
      assignee: index % 7 === 0 ? '' : ['Demo Alex', 'Demo Casey', 'Demo Morgan'][index % 3],
    };
    issues.push(issue);
    return issue;
  }

  const primary = addIssue('PM', null, 'Synthetic delivery program', 'Initiative', 170, { key: 'PM-100', resolved: false });
  for (let epicIndex = 0; epicIndex < 6; epicIndex++) {
    const age = 155 - epicIndex * 8;
    const epic = addIssue('PM', primary.issue_key, `Demo workstream ${epicIndex + 1}`, 'Epic', age, { resolved: false });
    for (let storyIndex = 0; storyIndex < 6; storyIndex++) {
      const project = ['PM', 'OPS', 'REL'][storyIndex % 3];
      const story = addIssue(project, epic.issue_key, `Synthetic ${project} deliverable ${epicIndex + 1}.${storyIndex + 1}`, 'Story', age - 10 - storyIndex * 5, { stale: storyIndex === 5 });
      if (storyIndex % 2 === 0) {
        addIssue(project, story.issue_key, `Demo validation ${epicIndex + 1}.${storyIndex + 1}`, 'Sub-task', age - 50 - storyIndex * 5);
      }
    }
  }

  const secondary = addIssue('PM', null, 'Synthetic maintenance program', 'Initiative', 90, { key: 'PM-200', resolved: false });
  for (let i = 0; i < 3; i++) {
    const task = addIssue('OPS', secondary.issue_key, `Demo maintenance task ${i + 1}`, 'Task', 70 - i * 10);
    for (let j = 0; j < 2; j++) {
      addIssue('REL', task.issue_key, `Demo maintenance check ${i + 1}.${j + 1}`, 'Sub-task', 40 - i * 5 - j * 5);
    }
  }

  // 12 epics + 288 stories + 3,456 subtasks = 3,756 descendants over three levels.
  const large = addIssue('PM', null, 'Synthetic scale program', 'Initiative', 175, { key: 'PM-300', resolved: false });
  for (let e = 0; e < 12; e++) {
    const epic = addIssue('PM', large.issue_key, `Scale epic ${e + 1}`, 'Epic', 160 - e * 2, { resolved: false });
    for (let s = 0; s < 24; s++) {
      const project = ['PM', 'OPS', 'REL'][s % 3];
      const story = addIssue(project, epic.issue_key, `Scale story ${e + 1}.${s + 1}`, 'Story', 120 - s * 2);
      for (let t = 0; t < 12; t++) {
        addIssue(project, story.issue_key, `Scale subtask ${e + 1}.${s + 1}.${t + 1}`, 'Sub-task', 60 - t * 3, { stale: s === 23 && t === 11 });
      }
    }
  }

  const orphan = addIssue('OPS', 'PM-999999', 'Demo orphan: parent not observed', 'Task', 80, { key: 'OPS-900001', stale: true, resolved: false });
  addIssue('REL', orphan.issue_key, 'Demo child of orphan', 'Sub-task', 50, { key: 'REL-900001', resolved: false });
  addIssue('REL', 'OPS-999999', 'Demo orphan: missing cross-project parent', 'Task', 30, { key: 'REL-900002', resolved: false });

  const reopened = addIssue('OPS', primary.issue_key, 'Demo reopened issue', 'Bug', 65, { key: 'OPS-900003', resolved: false });
  reopened.status = 'Reopened';
  reopened.status_category = 'indeterminate';
  const revisions = [
    { ...reopened, _time: daysAgo(7), sync_ts: daysAgo(7), is_resolved: true, resolved_at: daysAgo(8), status: 'Done', status_category: 'done' },
  ];
  for (const issue of issues.filter((_, index) => index % 17 === 0)) {
    const previous = { ...issue };
    delete previous.resolved_at;
    revisions.push({
      ...previous,
      _time: daysAgo(10),
      sync_ts: daysAgo(10),
      summary: `${issue.summary} (previous revision)`,
      is_resolved: false,
      status: 'In Progress',
      status_category: 'indeterminate',
    });
  }

  // Deliberately send older revisions LAST: query correctness must not depend on ingestion order.
  const rows = [...issues, ...revisions, { ...primary }];
  if (dryRun) {
    process.stdout.write(rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  } else {
    const endpoint = new URL('/insert/jsonline', base);
    endpoint.searchParams.set('_stream_fields', 'app,instance,environment');
    endpoint.searchParams.set('_time_field', '_time');
    // Retain summary as a regular contract field, not just VictoriaLogs' _msg.
    endpoint.searchParams.set('_msg_field', '_msg');
    for (let start = 0; start < rows.length; start += 500) {
      const body = rows.slice(start, start + 500)
        .map((row) => JSON.stringify({ ...row, _msg: row.summary })).join('\n') + '\n';
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/stream+json' },
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        throw new Error(`Seed batch at row ${start} failed: HTTP ${response.status} ${await response.text()}`);
      }
      await response.arrayBuffer();
    }
    console.log(`Seeded ${issues.length} issues in ${rows.length} observations into ${base.origin}.`);
    console.log('Roots: PM-100 (61 descendants), PM-200 (9 descendants), PM-300 (3756 descendants).');
    console.log('Includes missing parents, stale heartbeats, a reopened issue, older revisions, and an exact duplicate.');
  }
} catch (error) {
  console.error(`Development seed failed: ${error.message}`);
  process.exitCode = 1;
}
