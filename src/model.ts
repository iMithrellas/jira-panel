import type { DataFrame } from '@grafana/data';
import type { Issue, IssueNode, TreeRow } from './types';

function timestamp(value: unknown): number {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : NaN;
  }
  return typeof value === 'string' && value.trim() ? Date.parse(value) : NaN;
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return {}; }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

// Accept VictoriaLogs' native logs frames (a labels object per row) and flat tables.
export function readIssues(frames: DataFrame[], maxIssues: number) {
  const latest = new Map<string, Record<string, unknown>>();
  let invalid = 0;
  let rawRows = 0;
  for (const frame of frames) {
    for (let index = 0; index < frame.length; index++) {
      rawRows++;
      const row: Record<string, unknown> = {};
      for (const field of frame.fields) {
        if (field.name === 'labels') { Object.assign(row, object(field.values[index])); }
      }
      for (const field of frame.fields) {
        if (field.name !== 'labels') { row[field.name] = field.values[index]; }
      }
      const key = String(row.issue_key ?? '').trim();
      const observed = timestamp(row.sync_ts || row._time || row.Time);
      if (!key || !Number.isFinite(observed)) { invalid++; continue; }
      const source = JSON.stringify([row.app ?? '', row.instance ?? '', row.environment ?? '']);
      const id = JSON.stringify([source, key]);
      const previous = latest.get(id);
      if (!previous || observed > Number(previous.observed)) {
        latest.set(id, { ...row, id, source, key, observed });
      }
    }
  }
  const issues: Issue[] = [];
  for (const row of latest.values()) {
    const resolved = row.is_resolved === true || row.is_resolved === 'true';
    const hasResolutionFlag = resolved || row.is_resolved === false || row.is_resolved === 'false';
    const start = timestamp(row.created_at);
    const end = resolved ? timestamp(row.resolved_at) : Number(row.observed);
    if (!hasResolutionFlag || !Number.isFinite(start) || !Number.isFinite(end) || end < start) {
      invalid++;
      continue;
    }
    const text = (name: string) => String(row[name] ?? '');
    issues.push({
      id: text('id'), source: text('source'), key: text('key'), parentKey: text('parent_key'),
      project: text('project_key'), summary: text('summary'), type: text('issue_type'),
      status: text('status'), category: text('status_category'), assignee: text('assignee'),
      priority: text('priority'), start, end, observed: Number(row.observed), resolved,
    });
  }
  issues.sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }) || a.source.localeCompare(b.source));
  return { issues: issues.slice(0, maxIssues), invalid, truncated: issues.length > maxIssues, rawRows };
}

export function buildTree(issues: Issue[]) {
  const nodes = new Map<string, IssueNode>(issues.map((issue) => [issue.id, { issue, children: [] }]));
  for (const node of nodes.values()) {
    if (!node.issue.parentKey) { continue; }
    const parent = JSON.stringify([node.issue.source, node.issue.parentKey]);
    if (nodes.has(parent)) { node.parent = parent; }
    else { node.warning = `Parent ${node.issue.parentKey} is not in the query result`; }
  }
  // Follow parent pointers iteratively: even malformed, very deep trees cannot overflow the stack.
  const done = new Set<string>();
  for (const id of nodes.keys()) {
    const path = new Set<string>();
    let next: string | undefined = id;
    while (next && !done.has(next)) {
      const node: IssueNode = nodes.get(next)!;
      if (path.has(next)) {
        node.parent = undefined;
        node.warning = 'Cyclic parent relationship; shown as a root';
        break;
      }
      path.add(next);
      next = node.parent;
    }
    for (const visited of path) { done.add(visited); }
  }
  const roots: string[] = [];
  for (const [id, node] of nodes) {
    if (node.parent) { nodes.get(node.parent)!.children.push(id); }
    else { roots.push(id); }
  }
  return { nodes, roots };
}

export function selectRows(
  tree: ReturnType<typeof buildTree>, rootKey: string, search: string, projects: string[],
  expansion: Map<string, boolean>, initialDepth: number, rootSource?: string
) {
  const root = rootKey.trim().toLowerCase();
  const roots = root
    ? [...tree.nodes.values()].filter((n) => n.issue.key.toLowerCase() === root && (!rootSource || n.issue.source === rootSource)).map((n) => n.issue.id)
    : tree.roots;
  const scoped: Array<{ id: string; depth: number }> = [];
  const stack = [...roots].reverse().map((id) => ({ id, depth: 0 }));
  while (stack.length) {
    const entry = stack.pop()!;
    scoped.push(entry);
    const children = tree.nodes.get(entry.id)!.children;
    for (let i = children.length - 1; i >= 0; i--) { stack.push({ id: children[i], depth: entry.depth + 1 }); }
  }
  const query = search.trim().toLowerCase();
  const filtering = !!query || projects.length > 0;
  const matches = new Set<string>();
  const included = new Set<string>();
  for (const { id } of scoped) {
    const issue = tree.nodes.get(id)!.issue;
    if ((!projects.length || projects.includes(issue.project)) &&
      (!query || [issue.key, issue.summary, issue.status, issue.assignee, issue.type].some((s) => s.toLowerCase().includes(query)))) {
      matches.add(id);
      included.add(id);
    }
  }
  // A reverse traversal retains ancestor context in O(n), not O(n * tree depth).
  for (let i = scoped.length - 1; i >= 0; i--) {
    if (included.has(scoped[i].id)) {
      const parent = tree.nodes.get(scoped[i].id)!.parent;
      if (parent) { included.add(parent); }
    }
  }
  const rows: TreeRow[] = [];
  let collapsedDepth = Infinity;
  for (const { id, depth } of scoped) {
    if (depth > collapsedDepth) { continue; }
    collapsedDepth = Infinity;
    if (!included.has(id)) { continue; }
    const node = tree.nodes.get(id)!;
    const hasChildren = node.children.some((child) => included.has(child));
    const expanded = filtering || (expansion.get(id) ?? depth < initialDepth);
    rows.push({ node, depth, expanded, hasChildren, context: !matches.has(id) });
    if (!expanded) { collapsedDepth = depth; }
  }
  return { rows, scopedCount: scoped.length, matchingCount: matches.size, filtering,
    issues: scoped.filter(({ id }) => included.has(id)).map(({ id }) => tree.nodes.get(id)!.issue) };
}

export function fitRange(issues: Issue[]): [number, number] {
  if (!issues.length) { return [0, 1]; }
  let min = Infinity;
  let max = -Infinity;
  for (const issue of issues) { min = Math.min(min, issue.start); max = Math.max(max, issue.end); }
  const padding = Math.max((max - min) * 0.025, 3600000);
  return [min - padding, max + padding];
}

export function barPosition(start: number, end: number, range: [number, number]) {
  if (end < range[0] || start > range[1]) { return undefined; }
  const left = Math.max(0, (start - range[0]) / (range[1] - range[0]) * 100);
  const right = Math.min(100, (end - range[0]) / (range[1] - range[0]) * 100);
  return { left, width: Math.max(0, right - left) };
}

export function jiraLink(base: string, key: string): string | undefined {
  try {
    const url = new URL(base);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) { return undefined; }
    url.search = '';
    url.hash = '';
    url.pathname = `${url.pathname.replace(/\/$/, '')}/browse/${encodeURIComponent(key)}`;
    return url.href;
  } catch { return undefined; }
}
