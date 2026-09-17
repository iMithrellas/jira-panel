import type { DataFrame } from '@grafana/data';
import { defaultFieldMappings, type Issue, type IssueFieldMapping, type IssueLink, type JiraOptions, type MetadataValue, type RowOrigin, type SearchFieldOption, type ValidationDiagnostic } from './types';

const coreSearchFields = [
  { value: 'key', mapping: 'key', label: 'Key' },
  { value: 'summary', mapping: 'summary', label: 'Summary' },
  { value: 'status', mapping: 'status', label: 'Status' },
  { value: 'assignee', mapping: 'assignee', label: 'Assignee' },
  { value: 'type', mapping: 'type', label: 'Issue type' },
] as const;
const structuralFields = [
  'app', 'instance', 'environment', 'kind', 'parent_key', 'issue_links',
  'created_at', 'resolved_at', 'sync_ts', '_time', 'Time', 'time',
  'is_resolved', 'status_category', 'labels', 'Line', 'ts', 'id',
];
const structuralMappings = ['parent', 'links', 'created', 'observed', 'resolved', 'isResolved', 'category'] as const;
const textMappings = ['parent', 'project', 'summary', 'type', 'status', 'category', 'assignee', 'priority'] as const;
const diagnosticLimit = 20;

export function fieldNames(configured = ''): string[] {
  return [...new Set(configured.split(',').map((field) => field.trim()).filter(Boolean))];
}

export function resolveFieldMappings(configured: Partial<IssueFieldMapping> = {}): IssueFieldMapping {
  return Object.fromEntries(Object.entries(defaultFieldMappings).map(([key, fallback]) =>
    [key, configured[key as keyof IssueFieldMapping]?.trim() || fallback])) as IssueFieldMapping;
}

export function fieldLabel(name: string): string {
  const text = name.replace(/[_-]+/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function isMetadata(value: unknown): value is MetadataValue {
  const entries = Array.isArray(value) ? value : [value];
  return entries.length > 0 && entries.every((entry) => typeof entry === 'string' || typeof entry === 'boolean' ||
    (typeof entry === 'number' && Number.isFinite(entry)));
}

function searchableValues(row: Record<string, unknown>, fields: IssueFieldMapping, excluded: Set<string>): Issue['searchValues'] {
  const values: Issue['searchValues'] = {};
  for (const option of coreSearchFields) {
    const value = row[fields[option.mapping]];
    if (isMetadata(value)) { values[option.value] = (Array.isArray(value) ? value : [value]).map(String); }
  }
  const coreNames = new Set(coreSearchFields.map(({ mapping }) => fields[mapping]));
  for (const [name, value] of Object.entries(row)) {
    if (coreNames.has(name) || excluded.has(name) || name.startsWith('_') || !isMetadata(value)) { continue; }
    values[`field:${name}`] = (Array.isArray(value) ? value : [value]).map(String);
  }
  return values;
}

export function discoverSearchFields(issues: Issue[], configured = '', fields = defaultFieldMappings): SearchFieldOption[] {
  const names = new Set(issues.flatMap((issue) => Object.keys(issue.searchValues)));
  const custom = [...names].filter((name) => name.startsWith('field:')).sort().map((value): SearchFieldOption => {
    const field = value.slice(6);
    return { value: value as `field:${string}`, field, label: fieldLabel(field) };
  });
  const allowed = new Set(fieldNames(configured));
  return [...coreSearchFields.map(({ value, mapping, label }) => ({ value, field: fields[mapping], label })), ...custom]
    .filter((option) => !allowed.size || allowed.has(option.field));
}

export function selectMetadata(issue: Issue, configured = ''): Record<string, MetadataValue> {
  const allowed = new Set(fieldNames(configured));
  return Object.fromEntries(Object.entries(issue.metadata).filter(([name]) => !allowed.size || allowed.has(name)));
}

function timestamp(value: unknown): number {
  if (typeof value === 'number') { return new Date(value).getTime(); }
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value)) { return NaN; }
  const date = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value.slice(0, 10)) { return NaN; }
  return Date.parse(value);
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return {}; }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function discoverInputFields(frames: DataFrame[]): string[] {
  const names = new Set<string>();
  for (const frame of frames) {
    for (const field of frame.fields) {
      if (field.name !== 'labels') { names.add(field.name); }
      else {
        for (const value of field.values) {
          for (const name of Object.keys(object(value))) { names.add(name); }
        }
      }
    }
  }
  return [...names].sort();
}

type FieldError = Pick<ValidationDiagnostic, 'field' | 'reason'>;

function readLinks(value: unknown, field: string): { links: IssueLink[]; error?: FieldError } {
  const links: IssueLink[] = [];
  const fail = (path: string, reason: string) => ({ links, error: { field: path, reason } });
  if (value == null || value === '') { return { links }; }
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return fail(field, 'Expected a JSON-encoded relationship array'); }
  }
  if (!Array.isArray(value)) { return fail(field, 'Expected a relationship array'); }
  for (const [index, entry] of value.entries()) {
    const link = object(entry);
    const direction = link.direction;
    const target = link.target_key ?? link.targetKey;
    const targetKey = typeof target === 'string' ? target.trim() : '';
    const type = typeof link.type === 'string' ? link.type.trim() : '';
    const path = `${field}[${index}]`;
    if (!targetKey) { return fail(`${path}.target_key`, 'Expected a nonempty string'); }
    if (!type) { return fail(`${path}.type`, 'Expected a nonempty string'); }
    if (direction !== 'inward' && direction !== 'outward' && direction !== 'undirected') {
      return fail(`${path}.direction`, 'Expected inward, outward or undirected');
    }
    if (link.display != null && typeof link.display !== 'string') { return fail(`${path}.display`, 'Expected a string'); }
    links.push({ targetKey, type, display: typeof link.display === 'string' ? link.display : type, direction });
  }
  return { links };
}

export function readIssues(frames: DataFrame[], maxIssues: number, options: Partial<Pick<JiraOptions, 'fieldMappings' | 'sourceFields'>> = {}) {
  const fields = resolveFieldMappings(options.fieldMappings);
  const explicitSources = fieldNames(options.sourceFields);
  const sources = explicitSources.length ? explicitSources : ['app', 'instance', 'environment'];
  const excluded = new Set([...structuralFields, ...sources, ...structuralMappings.map((key) => fields[key])]);
  const mappedNames = new Set(Object.values(fields));
  const latest = new Map<string, { row: Record<string, unknown>; id: string; source: string; key: string; observed: number; origin: RowOrigin }>();
  const diagnostics: ValidationDiagnostic[] = [];
  let invalid = 0;
  let rawRows = 0;
  const reject = (origin: RowOrigin, key: string, error: FieldError) => {
    invalid++;
    if (diagnostics.length < diagnosticLimit) { diagnostics.push({ ...origin, key: key || undefined, ...error }); }
  };
  for (const [frameIndex, frame] of frames.entries()) {
    for (let index = 0; index < frame.length; index++) {
      rawRows++;
      const origin = { frameIndex, rowIndex: index, refId: frame.refId, frameName: frame.name };
      const row: Record<string, unknown> = Object.create(null);
      for (const field of frame.fields) {
        if (field.name === 'labels') { Object.assign(row, object(field.values[index])); }
      }
      // Direct fields take precedence over labels, including null or undefined values.
      for (const field of frame.fields) {
        if (field.name !== 'labels') { row[field.name] = field.values[index]; }
      }
      const rawKey = row[fields.key];
      const key = typeof rawKey === 'string' ? rawKey.trim() : '';
      const observationField = fields.observed === defaultFieldMappings.observed
        ? [fields.observed, '_time', 'Time'].find((name) => row[name] != null) ?? fields.observed
        : fields.observed;
      const observed = timestamp(row[observationField]);
      const invalidSource = sources.find((name) => explicitSources.length
        ? typeof row[name] !== 'string' || !row[name].trim()
        : row[name] != null && typeof row[name] !== 'string');
      const error = !key ? { field: fields.key, reason: 'Expected a nonempty issue key string' }
        : !Number.isFinite(observed) ? { field: observationField, reason: 'Expected a valid observation timestamp' }
          : invalidSource ? { field: invalidSource, reason: explicitSources.length ? 'Configured source fields require nonempty strings' : 'Expected a source string' }
            : undefined;
      if (error) { reject(origin, key, error); continue; }
      const source = JSON.stringify(sources.map((name) => row[name] ?? ''));
      const id = JSON.stringify([source, key]);
      const previous = latest.get(id);
      if (!previous || observed > previous.observed) { latest.set(id, { row, id, source, key, observed, origin }); }
    }
  }
  const issues: Issue[] = [];
  // Validate the selected row's remaining fields without falling back to older state.
  for (const { row, id, source, key, observed, origin } of latest.values()) {
    const flag = row[fields.isResolved];
    const resolved = flag === true || flag === 'true';
    const hasResolutionFlag = resolved || flag === false || flag === 'false';
    const start = timestamp(row[fields.created]);
    const end = resolved ? timestamp(row[fields.resolved]) : observed;
    const { links, error: linkError } = readLinks(row[fields.links], fields.links);
    const invalidText = textMappings.map((key) => fields[key]).find((name) => row[name] != null && typeof row[name] !== 'string');
    const error = !hasResolutionFlag ? { field: fields.isResolved, reason: 'Expected true or false (boolean or string)' }
      : !Number.isFinite(start) ? { field: fields.created, reason: 'Expected a valid creation timestamp' }
        : !Number.isFinite(end) ? { field: fields.resolved, reason: 'Resolved issues require a valid resolution timestamp' }
          : end < start ? { field: fields.created, reason: 'Creation must not be later than the issue end' }
            : end > observed ? { field: fields.resolved, reason: 'Resolution must not be later than the observation' }
              : invalidText ? { field: invalidText, reason: 'Expected a string or null' } : linkError;
    if (error) { reject(origin, key, error); continue; }
    const text = (key: keyof IssueFieldMapping) => typeof row[fields[key]] === 'string' ? row[fields[key]] as string : '';
    const metadata = Object.fromEntries(Object.entries(row).filter((entry): entry is [string, MetadataValue] =>
      !mappedNames.has(entry[0]) && !excluded.has(entry[0]) && !entry[0].startsWith('_') && isMetadata(entry[1])));
    issues.push({
      id, source, key, parentKey: text('parent').trim(),
      project: text('project'), summary: text('summary'), type: text('type'),
      status: text('status'), category: text('category'), assignee: text('assignee'),
      priority: text('priority'), start, end, observed, resolved, links, origin, metadata,
      fields: row, searchValues: searchableValues(row, fields, excluded),
    });
  }
  issues.sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }) || a.source.localeCompare(b.source));
  return { issues: issues.slice(0, maxIssues), invalid, diagnostics, truncated: issues.length > maxIssues, rawRows, fieldMappings: fields };
}
