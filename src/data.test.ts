import type { DataFrame } from '@grafana/data';
import { describe, expect, it } from 'vitest';
import { discoverInputFields, discoverSearchFields, readIssues, selectMetadata } from './data';
import { buildRelationships, buildTree, collapseCompleted, computeRollups, exportRecords, recordsToCsv, selectRows } from './model';
import type { IssueFieldMapping } from './types';

const table = (rows: Array<Record<string, unknown>>, refId = 'A'): DataFrame => ({
  refId, length: rows.length,
  fields: [...new Set(rows.flatMap(Object.keys))].map((name) => ({ name, type: 'other', config: {}, values: rows.map((row) => row[name]) })),
} as DataFrame);
const row = (key: string, extra: Record<string, unknown> = {}) => ({
  issue_key: key, created_at: 0, sync_ts: 100, is_resolved: false, ...extra,
});
const mappings: IssueFieldMapping = {
  key: 'id', parent: 'belongsTo', project: 'workspace', summary: 'title', type: 'kindOfWork',
  status: 'state', category: 'phase', assignee: 'owner', priority: 'rank', created: 'opened',
  observed: 'observedAt', resolved: 'finished', isResolved: 'closed', links: 'relations',
};
const mappedRow = (id: string, extra: Record<string, unknown> = {}) => ({
  id, opened: 0, observedAt: 100, closed: false, site: 'east', title: `Item ${id}`, ...extra,
});

describe('configurable issue input', () => {
  it('maps a non-Jira schema into hierarchy, search, lifecycle and relationships', () => {
    const result = readIssues([table([
      mappedRow('P-1', { workspace: 'Program' }),
      mappedRow('C-1', { belongsTo: 'P-1', workspace: 'Delivery', state: 'Finished', phase: 'done', owner: 'Alex', rank: 'High', kindOfWork: 'Task', closed: true, finished: 90,
        relations: [{ target_key: 'P-1', type: 'related', direction: 'undirected' }] }),
    ])], 100, { fieldMappings: mappings, sourceFields: 'site' });
    expect(result.invalid).toBe(0);
    const child = result.issues.find((issue) => issue.key === 'C-1')!;
    expect(child).toMatchObject({ parentKey: 'P-1', source: '["east"]', project: 'Delivery', status: 'Finished', category: 'done', assignee: 'Alex', priority: 'High', type: 'Task', start: 0, end: 90, resolved: true });
    const fields = discoverSearchFields(result.issues, 'id, title, owner', result.fieldMappings);
    expect(fields.map(({ field }) => field)).toEqual(['id', 'title', 'owner']);
    const tree = buildTree(result.issues);
    const selected = selectRows(tree, '', 'Alex', [], new Map(), 0, undefined, 'all', fields);
    expect(selected.rows.map(({ node }) => node.issue.key)).toEqual(['P-1', 'C-1']);
    expect(buildRelationships(tree, selected.rows)).toMatchObject([{ label: 'related', directed: false }]);
    expect(child.metadata).toEqual({});
    expect(discoverSearchFields(result.issues, '', result.fieldMappings).map(({ field }) => field)).not.toContain('site');
  });

  it('supports mapped fields in JSON labels with direct-field precedence', () => {
    const result = readIssues([table([{ labels: JSON.stringify(mappedRow('I-1')), title: 'Direct' }])], 10, { fieldMappings: mappings, sourceFields: 'site' });
    expect(result.issues[0].summary).toBe('Direct');
    expect(discoverInputFields([table([{ labels: JSON.stringify(mappedRow('I-1')), custom: true }])])).toEqual(['closed', 'custom', 'id', 'observedAt', 'opened', 'site', 'title']);
  });

  it('uses configured source fields to isolate identical keys and parent links', () => {
    const result = readIssues([table([
      mappedRow('P-1'), mappedRow('C-1', { belongsTo: 'P-1' }),
      mappedRow('P-1', { site: 'west', title: 'Other parent' }), mappedRow('C-1', { site: 'west', belongsTo: 'P-1' }),
    ])], 10, { fieldMappings: mappings, sourceFields: ' site, site ' });
    const tree = buildTree(result.issues);
    expect(tree.roots).toHaveLength(2);
    expect(selectRows(tree, 'P-1', '', [], new Map(), 2, '["east"]').issues).toHaveLength(2);
    expect(result.issues.filter((issue) => issue.key === 'P-1').map((issue) => issue.summary)).toEqual(['Item P-1', 'Other parent']);
  });

  it('requires explicitly configured source fields rather than merging unidentified sites', () => {
    const result = readIssues([table([
      row('I-1'), row('I-2', { site: null }), row('I-3', { site: ' ' }), row('I-4', { site: 'east' }),
    ])], 10, { sourceFields: 'site' });
    expect(result.issues.map((issue) => issue.key)).toEqual(['I-4']);
    expect(result.invalid).toBe(3);
    expect(result.diagnostics.every(({ field }) => field === 'site')).toBe(true);
    expect(readIssues([table([row('I-1')])], 10).invalid).toBe(0);
  });

  it('does not fall back to a different timestamp when an observation field is explicitly mapped', () => {
    const result = readIssues([table([row('I-1')])], 10, { fieldMappings: { observed: 'captured' } });
    expect(result.invalid).toBe(1);
    expect(result.diagnostics[0].field).toBe('captured');
  });

  it('retains the winning frame and row for Grafana display processors and data links', () => {
    const result = readIssues([
      table([mappedRow('I-1', { observedAt: 50 })], 'A'),
      table([mappedRow('I-2'), mappedRow('I-1', { observedAt: 200 })], 'B'),
    ], 10, { fieldMappings: mappings });
    expect(result.issues.find((issue) => issue.key === 'I-1')?.origin).toMatchObject({ refId: 'B', frameIndex: 1, rowIndex: 1 });
  });
});

describe('validation diagnostics', () => {
  it('identifies the mapped field and winning query row without restoring older state', () => {
    const result = readIssues([
      table([mappedRow('I-1')], 'A'),
      { ...table([mappedRow('I-1', { observedAt: 200, title: {} })], 'B'), name: 'Latest observations' },
    ], 10, { fieldMappings: mappings });
    expect(result.issues).toHaveLength(0);
    expect(result.diagnostics).toEqual([{ frameIndex: 1, rowIndex: 0, refId: 'B', frameName: 'Latest observations', key: 'I-1', field: 'title', reason: 'Expected a string or null' }]);
  });

  it('reports the invalid link element and property', () => {
    const result = readIssues([table([row('I-1', { issue_links: [{ target_key: 'I-2', type: 'related', direction: 'sideways' }] })])], 10);
    expect(result.diagnostics[0]).toMatchObject({ key: 'I-1', field: 'issue_links[0].direction', reason: 'Expected inward, outward or undirected' });
  });

  it('bounds samples while counting every rejected row', () => {
    const result = readIssues([table(Array.from({ length: 50 }, (_, i) => row(`I-${i}`, { created_at: 'invalid' })))], 10);
    expect(result.invalid).toBe(50);
    expect(result.diagnostics).toHaveLength(20);
    expect(result.diagnostics.every(({ field }) => field === 'created_at')).toBe(true);
  });
});

describe('custom metadata', () => {
  it('preserves sparse scalar values and arrays, including names that collide with export columns', () => {
    const result = readIssues([table([
      row('P-1'), row('C-1', { parent_key: 'P-1', company: 'Acme', score: 0, active: false, tags: ['a', 'b'], depth: 999,
        nested: { hidden: true }, mixed: [null], absent: null, empty: [], invalidNumber: Infinity }),
    ])], 10);
    const child = result.issues.find((issue) => issue.key === 'C-1')!;
    expect(child.metadata).toEqual({ company: 'Acme', score: 0, active: false, tags: ['a', 'b'], depth: 999 });
    expect(selectMetadata(child, 'company, score')).toEqual({ company: 'Acme', score: 0 });
    const tree = buildTree(result.issues);
    const exported = exportRecords(selectRows(tree, '', '', [], new Map(), 0).exportRows, new Map());
    expect(exported[1]).toMatchObject({ depth: 1, custom_fields: { company: 'Acme', depth: 999, score: 0, active: false, tags: ['a', 'b'] } });
    expect(recordsToCsv(exported)).toContain('Acme');
    expect(exportRecords(selectRows(tree, '', '', [], new Map(), 0).exportRows, new Map(), 'company')[1].custom_fields).toEqual({ company: 'Acme' });
  });

  it('uses only metadata from the latest complete observation', () => {
    const result = readIssues([table([row('I-1', { company: 'Old' }), row('I-1', { sync_ts: 200, score: 1 })])], 10);
    expect(result.issues[0].metadata).toEqual({ score: 1 });
  });
});

describe('explicit hierarchy policies', () => {
  it('distinguishes resolved-parent, complete-subtree and legacy collapse modes', () => {
    const issues = readIssues([table([
      row('P-1', { is_resolved: true, resolved_at: 90 }), row('C-1', { parent_key: 'P-1' }),
      row('P-2'), row('C-2', { parent_key: 'P-2', is_resolved: true, resolved_at: 90 }),
      row('P-3', { is_resolved: true, resolved_at: 90 }), row('C-3', { parent_key: 'P-3', is_resolved: true, resolved_at: 90 }),
    ])], 10).issues;
    const tree = buildTree(issues);
    const rollups = computeRollups(tree, 100, 100);
    const parentExpansion = (mode: Parameters<typeof collapseCompleted>[2]) => {
      const expansion = collapseCompleted(tree, rollups, mode);
      return issues.filter((issue) => issue.key.startsWith('P-')).map((issue) => expansion.get(issue.id));
    };
    expect(parentExpansion('parent-or-descendants')).toEqual([false, false, false]);
    expect(parentExpansion('parent')).toEqual([false, true, false]);
    expect(parentExpansion('subtree')).toEqual([true, true, false]);
  });

  it('deduplicates undirected links without merging directed links or crossing sources', () => {
    const issues = readIssues([table([
      row('I-1', { issue_links: [{ target_key: 'I-2', type: 'related', direction: 'undirected' }, { target_key: 'I-2', type: 'related', direction: 'outward' }] }),
      row('I-2', { issue_links: [{ target_key: 'I-1', type: 'related', direction: 'undirected' }] }),
      row('I-3', { instance: 'other', issue_links: [{ target_key: 'I-1', type: 'related', direction: 'undirected' }] }),
    ])], 10).issues;
    const tree = buildTree(issues);
    const relationships = buildRelationships(tree, selectRows(tree, '', '', [], new Map(), 2).rows);
    expect(relationships).toHaveLength(2);
    expect(relationships.map(({ directed }) => directed)).toEqual([false, true]);
  });
});
