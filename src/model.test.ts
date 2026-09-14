import type { DataFrame } from '@grafana/data';
import { describe, expect, it } from 'vitest';
import { barPosition, buildTree, collapseCompleted, computeRollups, expansionForDepth, exportRecords, fitRange, jiraLink, readIssues, recordsToCsv, selectRows } from './model';

const observed = '2026-09-06T12:00:00Z';
const created = '2026-06-01T12:00:00Z';
const record = (key: string, parent = '', extra: Record<string, unknown> = {}) => ({
  app: 'jira-exporter', instance: 'test', environment: 'dev', issue_key: key,
  project_key: key.split('-')[0], parent_key: parent, summary: `Ticket ${key}`,
  is_resolved: false, created_at: created, sync_ts: observed, ...extra,
});
const logs = (rows: Record<string, unknown>[]): DataFrame => ({
  length: rows.length, fields: [{ name: 'labels', type: 'other', config: {}, values: rows }],
} as DataFrame);
const table = (rows: Record<string, unknown>[]): DataFrame => ({
  length: rows.length,
  fields: [...new Set(rows.flatMap(Object.keys))].map((name) => ({ name, type: 'string', config: {}, values: rows.map((row) => row[name]) })),
} as DataFrame);
const issues = (rows: Record<string, unknown>[]) => readIssues([logs(rows)], 10000).issues;

describe('heartbeat data contract', () => {
  it('reads both native VictoriaLogs frames and flat tables', () => {
    const rows = [record('OPS-1'), record('OPS-2')];
    expect(readIssues([logs(rows)], 100)).toEqual(readIssues([table(rows)], 100));
  });

  it('accepts JSON labels and millisecond time columns', () => {
    const row = record('OPS-1', '', { sync_ts: undefined });
    const frame = { length: 1, fields: [
      { name: 'labels', values: [JSON.stringify(row)] },
      { name: 'Time', values: [Date.parse(observed)] },
    ] } as DataFrame;
    expect(readIssues([frame], 10).issues[0].end).toBe(Date.parse(observed));
  });

  it('uses last observed for open issues, not now or stale resolved_at', () => {
    const [issue] = issues([record('OPS-1', '', { resolved_at: '2026-08-01T00:00:00Z', is_resolved: 'false' })]);
    expect(issue.end).toBe(Date.parse(observed));
    expect(issue.resolved).toBe(false);
  });

  it('uses the resolution date and handles string booleans', () => {
    const [issue] = issues([record('OPS-1', '', { resolved_at: '2026-08-01T00:00:00Z', is_resolved: 'true' })]);
    expect(issue.end).toBe(Date.parse('2026-08-01T00:00:00Z'));
    expect(issue.resolved).toBe(true);
  });

  it('selects complete newest rows across frames, clearing removed parent/resolution fields', () => {
    const old = record('OPS-1', 'PM-1', { is_resolved: true, resolved_at: '2026-08-01T00:00:00Z', sync_ts: '2026-09-01T00:00:00Z' });
    const latest = record('OPS-1', '', { summary: 'Reopened' });
    const result = readIssues([logs([latest]), table([old, latest])], 100);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({ parentKey: '', resolved: false, summary: 'Reopened' });
  });

  it('never substitutes an older valid record for a malformed latest observation', () => {
    const result = readIssues([logs([record('OPS-1'), record('OPS-1', '', { sync_ts: '2026-09-07T12:00:00Z', created_at: 'broken' })])], 10);
    expect(result.issues).toHaveLength(0);
    expect(result.invalid).toBe(1);
  });

  it('rejects missing contract fields, invalid dates and inverted intervals, preserving zero duration', () => {
    const result = readIssues([logs([
      record('OPS-1', '', { is_resolved: undefined }), record('OPS-2', '', { is_resolved: true }),
      record('OPS-3', '', { created_at: 'garbage' }), record('OPS-4', '', { created_at: '2027-01-01' }),
      record('OPS-5', '', { created_at: observed }),
    ])], 10);
    expect(result.invalid).toBe(4);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].start).toBe(result.issues[0].end);
  });

  it('caps unique issues with a warning, not raw duplicate observations', () => {
    expect(readIssues([logs([record('OPS-1'), record('OPS-1')])], 1).truncated).toBe(false);
    const result = readIssues([logs([record('OPS-1'), record('OPS-2')])], 1);
    expect(result.truncated).toBe(true);
    expect(result.issues).toHaveLength(1);
  });
});

describe('real parent hierarchy', () => {
  const data = issues([record('PM-1'), record('OPS-1', 'PM-1'), record('REL-1', 'OPS-1'), record('PM-2'), record('OPS-2', 'PM-2')]);
  const tree = buildTree(data);
  const select = (root = '', search = '', projects: string[] = [], depth = 2) => selectRows(tree, root, search, projects, new Map(), depth);

  it('includes only the requested subtree, including cross-project descendants', () => {
    expect(select('pm-1').issues.map((i) => i.key)).toEqual(['PM-1', 'OPS-1', 'REL-1']);
    expect(select('missing').rows).toEqual([]);
  });

  it('search and project filters retain ancestors and automatically expose matches', () => {
    const result = select('PM-1', 'REL-1', ['REL'], 0);
    expect(result.matchingCount).toBe(1);
    expect(result.rows.map((r) => [r.node.issue.key, r.context])).toEqual([['PM-1', true], ['OPS-1', true], ['REL-1', false]]);
  });

  it('collapses descendants without changing fitted extents or matched count', () => {
    const result = select('PM-1', '', [], 0);
    expect(result.rows).toHaveLength(1);
    expect(result.issues).toHaveLength(3);
    expect(result.matchingCount).toBe(3);
  });

  it('isolates identical ticket keys in different sources', () => {
    const result = buildTree(issues([record('PM-1'), record('OPS-1', 'PM-1', { instance: 'different' })]));
    expect(result.roots).toHaveLength(2);
    expect([...result.nodes.values()].find((n) => n.issue.key === 'OPS-1')?.warning).toContain('not in the query result');
  });

  it('keeps missing parents and their descendants visible', () => {
    const result = buildTree(issues([record('OPS-1', 'MISSING'), record('REL-1', 'OPS-1')]));
    expect(result.roots).toHaveLength(1);
    expect(selectRows(result, '', '', [], new Map(), 10).rows).toHaveLength(2);
  });

  it('focuses a selected source without including another source with the same root key', () => {
    const data = issues([record('PM-1'), record('OPS-1', 'PM-1'),
      record('PM-1', '', { instance: 'different' }), record('REL-1', 'PM-1', { instance: 'different' })]);
    const tree = buildTree(data);
    const source = data.find((issue) => issue.key === 'OPS-1')!.source;
    expect(selectRows(tree, 'PM-1', '', [], new Map(), 10, source).issues.map((issue) => issue.key)).toEqual(['PM-1', 'OPS-1']);
    expect(selectRows(tree, 'PM-1', '', [], new Map(), 10).issues).toHaveLength(4);
  });

  it('breaks cycles and self parents without losing issues or hanging', () => {
    const result = buildTree(issues([record('OPS-1', 'OPS-2'), record('OPS-2', 'OPS-1'), record('OPS-3', 'OPS-3')]));
    expect(result.roots).toHaveLength(2);
    expect([...result.nodes.values()].filter((n) => n.warning)).toHaveLength(2);
    expect(selectRows(result, '', '', [], new Map(), 10).rows).toHaveLength(3);
  });

  it('handles a 10,000-level chain iteratively and preserves search context', () => {
    const rows = Array.from({ length: 10000 }, (_, i) => record(`OPS-${i}`, i ? `OPS-${i - 1}` : ''));
    const result = selectRows(buildTree(issues(rows)), 'OPS-0', 'OPS-9999', [], new Map(), 2);
    expect(result.rows).toHaveLength(10000);
    expect(result.matchingCount).toBe(1);
  });

  it('computes descendant completion and stale rollups without counting the row itself', () => {
    const tree = buildTree(issues([
      record('PM-1'),
      record('OPS-1', 'PM-1', { is_resolved: true, resolved_at: '2026-08-01T00:00:00Z' }),
      record('REL-1', 'OPS-1', { sync_ts: '2026-08-01T00:00:00Z' }),
    ]));
    const rollups = computeRollups(tree, Date.parse('2026-09-01T00:00:00Z'), 24 * 3600000);
    const pm = [...tree.nodes.values()].find((node) => node.issue.key === 'PM-1')!;
    const ops = [...tree.nodes.values()].find((node) => node.issue.key === 'OPS-1')!;
    expect(rollups.get(pm.issue.id)).toEqual({ descendants: 2, doneDescendants: 1, staleDescendants: 1 });
    expect(rollups.get(ops.issue.id)).toEqual({ descendants: 1, doneDescendants: 0, staleDescendants: 1 });
  });

  it('expands through a chosen depth and collapses only fully resolved branches', () => {
    const data = issues([
      record('PM-1'), record('OPS-1', 'PM-1', { is_resolved: true, resolved_at: '2026-08-01T00:00:00Z' }),
      record('REL-1', 'OPS-1', { is_resolved: true, resolved_at: '2026-08-02T00:00:00Z' }), record('OPS-2', 'PM-1'),
    ]);
    const tree = buildTree(data);
    const root = tree.nodes.get(data.find((issue) => issue.key === 'PM-1')!.id)!;
    const depth = expansionForDepth(tree, 'PM-1', 1);
    expect(depth.get(root.issue.id)).toBe(true);
    expect(depth.get(tree.nodes.get(data.find((issue) => issue.key === 'OPS-1')!.id)!.issue.id)).toBe(false);
    const collapsed = collapseCompleted(tree, computeRollups(tree, Date.now(), 3600000));
    expect(collapsed.get(root.issue.id)).toBe(true);
    expect(collapsed.get(data.find((issue) => issue.key === 'OPS-1')!.id)).toBe(false);
    expect(collapsed.get(data.find((issue) => issue.key === 'OPS-2')!.id)).toBe(true);
  });

  it('exports the complete filtered tree with rollups and escapes CSV cells', () => {
    const data = issues([record('PM-1', '', { summary: 'A, "quoted" summary' }), record('OPS-1', 'PM-1')]);
    const tree = buildTree(data);
    const selected = selectRows(tree, 'PM-1', '', [], new Map(), 0);
    const records = exportRecords(selected.exportRows, computeRollups(tree, Date.now(), 3600000));
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ issue_key: 'PM-1', child_count: 1, depth: 0 });
    expect(records[1]).toMatchObject({ issue_key: 'OPS-1', parent_key: 'PM-1', depth: 1 });
    expect(recordsToCsv(records)).toContain('"A, ""quoted"" summary"');
    expect(recordsToCsv([])).toBe('');
  });
});

describe('timeline and links', () => {
  it('clips overlapping bars, keeps milestones and excludes outside bars', () => {
    expect(barPosition(-10, 50, [0, 100])).toEqual({ left: 0, width: 50 });
    expect(barPosition(50, 120, [0, 100])).toEqual({ left: 50, width: 50 });
    expect(barPosition(30, 30, [0, 100])).toEqual({ left: 30, width: 0 });
    expect(barPosition(101, 120, [0, 100])).toBeUndefined();
  });

  it('fits zero-duration issues with a nonzero range', () => {
    const [from, to] = fitRange(issues([record('OPS-1', '', { created_at: observed })]));
    expect(from).toBeLessThan(Date.parse(observed));
    expect(to).toBeGreaterThan(Date.parse(observed));
  });

  it('encodes keys, preserves Jira context paths and rejects unsafe URL schemes', () => {
    expect(jiraLink('https://jira.example/jira/?q=1#x', 'OPS-1')).toBe('https://jira.example/jira/browse/OPS-1');
    expect(jiraLink('https://jira.example', 'x/y')).toBe('https://jira.example/browse/x%2Fy');
    expect(jiraLink('javascript:alert(1)', 'OPS-1')).toBeUndefined();
    expect(jiraLink('https://user:password@jira.example', 'OPS-1')).toBeUndefined();
  });
});
