import { selectMetadata } from './data';
import type { CollapseMode, Issue, IssueNode, Relationship, Rollup, SearchField, SearchFieldOption, TreeRow } from './types';

export function buildTree(issues: Issue[]) {
  const nodes = new Map<string, IssueNode>(issues.map((issue) => [issue.id, { issue, children: [] }]));
  for (const node of nodes.values()) {
    if (!node.issue.parentKey) { continue; }
    const parent = JSON.stringify([node.issue.source, node.issue.parentKey]);
    if (nodes.has(parent)) { node.parent = parent; }
    else { node.warning = `Parent ${node.issue.parentKey} is not in the query result`; }
  }
  // Iterative cycle detection also handles trees deeper than the call stack allows.
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

export function collapseCompleted(tree: ReturnType<typeof buildTree>, rollups: Map<string, Rollup>, mode: CollapseMode = 'parent-or-descendants') {
  const expansion = new Map<string, boolean>();
  for (const [id, node] of tree.nodes) {
    const rollup = rollups.get(id);
    const descendantsDone = !!rollup && rollup.doneDescendants === rollup.descendants;
    const completed = mode === 'parent' ? node.issue.resolved
      : mode === 'subtree' ? node.issue.resolved && descendantsDone
        : node.issue.resolved || (descendantsDone && rollup.descendants > 0);
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
      const directed = link.direction !== 'undirected';
      const [fromId, toId] = !directed ? [issue.id, targetID].sort()
        : link.direction === 'outward' ? [issue.id, targetID] : [targetID, issue.id];
      if (!rowIndex.has(fromId) || !rowIndex.has(toId)) { continue; }
      const edge = JSON.stringify([fromId, toId, link.type, directed]);
      if (seen.has(edge)) { continue; }
      seen.add(edge);
      relationships.push({ fromId, toId, fromRow: rowIndex.get(fromId)!, toRow: rowIndex.get(toId)!, label: link.type, directed });
    }
  }
  return relationships;
}

export function selectRows(
  tree: ReturnType<typeof buildTree>, rootKey: string, search: string, projects: string[],
  expansion: Map<string, boolean>, initialDepth: number, rootSource?: string, searchField: SearchField = 'all',
  enabledFields?: SearchFieldOption[]
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
    const searchable = searchField === 'all'
      ? enabledFields ? enabledFields.flatMap(({ value }) => issue.searchValues[value] ?? []) : Object.values(issue.searchValues).flatMap((values) => values ?? [])
      : enabledFields && !enabledFields.some(({ value }) => value === searchField) ? [] : issue.searchValues[searchField] ?? [];
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

export function exportRecords(rows: Array<{ node: IssueNode; depth: number }>, rollups: Map<string, Rollup>, metadataFields = '') {
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
      custom_fields: selectMetadata(node.issue, metadataFields),
    };
  });
}

export function recordsToCsv(records: Array<Record<string, unknown>>) {
  if (!records.length) { return ''; }
  const columns = Object.keys(records[0]);
  const cell = (value: unknown) => {
    let text = value === undefined || value === null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
    // CSV quoting alone does not prevent spreadsheet formula execution.
    if (typeof value === 'string' && (/^[\s\x00-\x1f]*[=+@-]/u.test(text) || /^[\t\r\n]/.test(text))) { text = `'${text}`; }
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
