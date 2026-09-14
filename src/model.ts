import type { DataFrame } from '@grafana/data';
import type { Issue, IssueLink, IssueNode, Relationship, Rollup, SearchField, TreeRow } from './types';

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

function array(value: unknown): unknown[] {
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return []; }
  }
  return Array.isArray(value) ? value : [];
}

function readLinks(value: unknown): IssueLink[] {
  return array(value).flatMap((entry) => {
    const link = object(entry);
    const direction = link.direction === 'inward' ? 'inward' : link.direction === 'outward' ? 'outward' : undefined;
    const targetKey = String(link.target_key ?? link.targetKey ?? '').trim();
    const type = String(link.type ?? '').trim();
    if (!direction || !targetKey || !type) { return []; }
    return [{ targetKey, type, display: String(link.display ?? type), direction }];
  });
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
      links: readLinks(row.issue_links),
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

export function computeRollups(tree: ReturnType<typeof buildTree>, now: number, staleMs: number) {
  const rollups = new Map<string, Rollup>();
  const visited = new Set<string>();
  for (const start of tree.nodes.keys()) {
    if (visited.has(start)) { continue; }
    const stack: Array<[string, boolean]> = [[start, false]];
    while (stack.length) {
      const [id, expanded] = stack.pop()!;
      if (expanded) {
        const rollup: Rollup = { descendants: 0, doneDescendants: 0, staleDescendants: 0 };
        for (const child of tree.nodes.get(id)!.children) {
          const childNode = tree.nodes.get(child)!;
          const childRollup = rollups.get(child) ?? { descendants: 0, doneDescendants: 0, staleDescendants: 0 };
          rollup.descendants += 1 + childRollup.descendants;
          rollup.doneDescendants += (childNode.issue.resolved ? 1 : 0) + childRollup.doneDescendants;
          rollup.staleDescendants += (now - childNode.issue.observed > staleMs ? 1 : 0) + childRollup.staleDescendants;
        }
        rollups.set(id, rollup);
        visited.add(id);
        continue;
      }
      stack.push([id, true]);
      const children = tree.nodes.get(id)!.children;
      for (const child of children) {
        if (!visited.has(child)) { stack.push([child, false]); }
      }
    }
  }
  return rollups;
}

function rootIDs(tree: ReturnType<typeof buildTree>, rootKey: string, rootSource?: string) {
  const root = rootKey.trim().toLowerCase();
  return root
    ? [...tree.nodes.values()].filter((n) => n.issue.key.toLowerCase() === root && (!rootSource || n.issue.source === rootSource)).map((n) => n.issue.id)
    : tree.roots;
}

export function expansionForDepth(tree: ReturnType<typeof buildTree>, rootKey: string, depth: number, rootSource?: string) {
  const expansion = new Map<string, boolean>();
  const stack = rootIDs(tree, rootKey, rootSource).reverse().map((id) => ({ id, depth: 0 }));
  while (stack.length) {
    const entry = stack.pop()!;
    const node = tree.nodes.get(entry.id)!;
    expansion.set(entry.id, entry.depth < depth);
    for (let i = node.children.length - 1; i >= 0; i--) {
      stack.push({ id: node.children[i], depth: entry.depth + 1 });
    }
  }
  return expansion;
}

export function collapseCompleted(tree: ReturnType<typeof buildTree>, rollups: Map<string, Rollup>) {
  const expansion = new Map<string, boolean>();
  for (const [id, node] of tree.nodes) {
    const rollup = rollups.get(id);
    // A resolved parent is operationally complete even when Jira leaves a child
    // open; the rollup badge keeps that exception visible without expanding it.
    const completed = node.issue.resolved || (!!rollup && rollup.descendants > 0 && rollup.doneDescendants === rollup.descendants);
    expansion.set(id, !completed);
  }
  return expansion;
}

export function buildRelationships(tree: ReturnType<typeof buildTree>, rows: TreeRow[]): Relationship[] {
  const rowIndex = new Map(rows.map((row, index) => [row.node.issue.id, index]));
  const relationships: Relationship[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const issue = row.node.issue;
    for (const link of issue.links) {
      const targetID = JSON.stringify([issue.source, link.targetKey]);
      const target = tree.nodes.get(targetID);
      if (!target) { continue; }
      const fromId = link.direction === 'outward' ? issue.id : targetID;
      const toId = link.direction === 'outward' ? targetID : issue.id;
      if (!rowIndex.has(fromId) || !rowIndex.has(toId)) { continue; }
      const edge = [fromId, toId].sort().join('|') + `|${link.type}`;
      if (seen.has(edge)) { continue; }
      seen.add(edge);
      relationships.push({ fromId, toId, fromRow: rowIndex.get(fromId)!, toRow: rowIndex.get(toId)!, label: link.type || link.display });
    }
  }
  return relationships;
}

export function selectRows(
  tree: ReturnType<typeof buildTree>, rootKey: string, search: string, projects: string[],
  expansion: Map<string, boolean>, initialDepth: number, rootSource?: string, searchField: SearchField = 'all'
) {
  const roots = rootIDs(tree, rootKey, rootSource);
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
    const searchable = searchField === 'all' ? [issue.key, issue.summary, issue.status, issue.assignee, issue.type] : [issue[searchField]];
    if ((!projects.length || projects.includes(issue.project)) &&
      (!query || searchable.some((s) => s.toLowerCase().includes(query)))) {
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
  const exportRows = scoped.filter(({ id }) => included.has(id)).map(({ id, depth }) => ({ node: tree.nodes.get(id)!, depth }));
  return { rows, scopedCount: scoped.length, matchingCount: matches.size, matchingIds: scoped.filter(({ id }) => matches.has(id)).map(({ id }) => id), filtering,
    exportRows, issues: exportRows.map(({ node }) => node.issue) };
}

export function exportRecords(rows: Array<{ node: IssueNode; depth: number }>, rollups: Map<string, Rollup>) {
  return rows.map(({ node, depth }) => {
    const rollup = rollups.get(node.issue.id) ?? { descendants: 0, doneDescendants: 0, staleDescendants: 0 };
    return {
      issue_key: node.issue.key,
      parent_key: node.issue.parentKey,
      project_key: node.issue.project,
      summary: node.issue.summary,
      issue_type: node.issue.type,
      status: node.issue.status,
      status_category: node.issue.category,
      assignee: node.issue.assignee,
      priority: node.issue.priority,
      created_at: new Date(node.issue.start).toISOString(),
      end_at: new Date(node.issue.end).toISOString(),
      observed_at: new Date(node.issue.observed).toISOString(),
      is_resolved: node.issue.resolved,
      depth,
      child_count: rollup.descendants,
      child_done_count: rollup.doneDescendants,
      child_stale_count: rollup.staleDescendants,
      source: node.issue.source,
      links: node.issue.links.map((link) => ({ ...link })),
    };
  });
}

export function recordsToCsv(records: Array<Record<string, unknown>>) {
  if (!records.length) { return ''; }
  const columns = Object.keys(records[0]);
  const cell = (value: unknown) => {
    const text = value === undefined || value === null ? '' : String(value);
    return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return [columns, ...records.map((record) => columns.map((column) => record[column]))].map((row) => row.map(cell).join(',')).join('\r\n') + '\r\n';
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
