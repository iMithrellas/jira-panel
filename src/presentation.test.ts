import type { DataFrame } from '@grafana/data';
import { describe, expect, it, vi } from 'vitest';
import { readIssues } from './data';
import { presentField, ticketLinks } from './presentation';

const input = (rows: Array<Record<string, unknown>>): DataFrame => ({
  length: rows.length,
  fields: [...new Set(rows.flatMap(Object.keys))].map((name) => ({ name, type: 'other', config: {}, values: rows.map((row) => row[name]) })),
} as DataFrame);
const row = (extra: Record<string, unknown> = {}) => ({ issue_key: 'I-1', created_at: 0, sync_ts: 100, is_resolved: false, ...extra });

describe('Grafana field presentation', () => {
  it('uses native display names, units, value mappings and colors without rewriting raw values', () => {
    const frame = input([row({ effort: 2.5 })]);
    const field = frame.fields.find(({ name }) => name === 'effort')!;
    field.config.displayName = 'Estimated effort';
    field.state = { displayName: 'Estimated effort' };
    field.display = vi.fn(() => ({ numeric: 2.5, text: '2.50', suffix: ' h', color: '#123456' }));
    const issue = readIssues([frame], 10).issues[0];
    expect(presentField(frame, issue, 'effort')).toEqual({ label: 'Estimated effort', text: '2.50 h', color: '#123456' });
    expect(field.display).toHaveBeenCalledWith(2.5);
    expect(issue.metadata.effort).toBe(2.5);
  });

  it('formats labels-only metadata and arrays without native field processors', () => {
    const frame = input([{ labels: row({ company: 'Acme', tags: ['a', 'b'], active: false }) }]);
    const issue = readIssues([frame], 10).issues[0];
    expect(presentField(frame, issue, 'company')).toMatchObject({ label: 'Company', text: 'Acme' });
    expect(presentField(frame, issue, 'tags').text).toBe('a, b');
    expect(presentField(frame, issue, 'active').text).toBe('false');
  });

  it('falls back safely when a configured display or color field contains structured values', () => {
    const frame = input([row({ nested: { toString: null } })]);
    const field = frame.fields.find(({ name }) => name === 'nested')!;
    field.display = vi.fn(() => { throw new Error('Not a scalar'); });
    const issue = readIssues([frame], 10).issues[0];
    expect(presentField(frame, issue, 'nested')).toMatchObject({ text: '', color: undefined });
    expect(field.display).not.toHaveBeenCalled();
  });
});

describe('ticket navigation', () => {
  it('uses Grafana data links for the winning row of a mapped key field', () => {
    const old = input([row({ key: 'I-1' })]);
    const latest = input([row({ key: 'I-2' }), row({ key: 'I-1', sync_ts: 200 })]);
    const field = latest.fields.find(({ name }) => name === 'key')!;
    const onClick = vi.fn();
    field.getLinks = vi.fn(({ valueRowIndex }) => [{ title: 'Inspect', href: `/d/issues?row=${valueRowIndex}`, target: '_self' as const, origin: field, onClick }]);
    const issue = readIssues([old, latest], 10, { fieldMappings: { key: 'key' } }).issues.find(({ key }) => key === 'I-1')!;
    const result = ticketLinks([old, latest][issue.origin.frameIndex], issue, { keyField: 'key', baseUrl: 'https://wrong.example' });
    expect(field.getLinks).toHaveBeenCalledWith({ valueRowIndex: 1 });
    expect(result.links).toMatchObject([{ href: '/d/issues?row=1', title: 'Inspect', target: '_self', onClick }]);
  });

  it('supports distinct per-row URLs for identical keys in different sources', () => {
    const frame = input([row({ instance: 'east', url: 'https://east.example/issues/I-1' }), row({ instance: 'west', url: 'https://west.example/issues/I-1' })]);
    const issues = readIssues([frame], 10).issues;
    expect(issues.map((issue) => ticketLinks(frame, issue, { keyField: 'issue_key', urlField: 'url', baseUrl: 'https://wrong.example' }).links[0].href))
      .toEqual(['https://east.example/issues/I-1', 'https://west.example/issues/I-1']);
  });

  it.each([undefined, {}, '', 'javascript:alert(1)', 'https://user:password@example.test', '/relative'])('does not fall back to a different site for an invalid configured URL: %j', (url) => {
    const frame = input([row({ url })]);
    const result = ticketLinks(frame, readIssues([frame], 10).issues[0], { keyField: 'issue_key', urlField: 'url', baseUrl: 'https://wrong.example' });
    expect(result.links).toEqual([]);
    expect(result.warning).toContain('missing or invalid');
  });

  it('filters unsafe native links while preserving valid callbacks and navigation targets', () => {
    const frame = input([row()]);
    const field = frame.fields.find(({ name }) => name === 'issue_key')!;
    field.getLinks = () => ['javascript:alert(1)', '//example.test', '/\\example.test', '/d/good', 'https://example.test/ok'].map((href) => ({ href, title: href, target: '_blank', origin: field }));
    const result = ticketLinks(frame, readIssues([frame], 10).issues[0], { keyField: 'issue_key' });
    expect(result.links.map(({ href }) => href)).toEqual(['/d/good', 'https://example.test/ok']);
    expect(result.warning).toBeDefined();
  });

  it('retains the Jira context-path fallback when no other link source is configured', () => {
    const frame = input([row()]);
    expect(ticketLinks(frame, readIssues([frame], 10).issues[0], { keyField: 'issue_key', baseUrl: 'https://jira.example/context/' }).links)
      .toMatchObject([{ title: 'Open in Jira', href: 'https://jira.example/context/browse/I-1' }]);
  });
});
