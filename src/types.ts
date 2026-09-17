export interface JiraOptions {
  rootKey: string;
  initialDepth: number;
  staleHours: number;
  jiraBaseUrl: string;
  maxIssues: number;
  rowHeight: number;
  labelWidth: number;
  searchableFields: string;
  fieldMappings: Partial<IssueFieldMapping>;
  sourceFields: string;
  metadataFields: string;
  issueUrlField: string;
  colorField: string;
  collapseMode: CollapseMode;
}

export const defaultFieldMappings = {
  key: 'issue_key', parent: 'parent_key', project: 'project_key', summary: 'summary',
  type: 'issue_type', status: 'status', category: 'status_category', assignee: 'assignee',
  priority: 'priority', created: 'created_at', observed: 'sync_ts', resolved: 'resolved_at',
  isResolved: 'is_resolved', links: 'issue_links',
};

export type IssueFieldMapping = Record<keyof typeof defaultFieldMappings, string>;
export type CollapseMode = 'parent-or-descendants' | 'parent' | 'subtree';
export type LinkDirection = 'inward' | 'outward' | 'undirected';
export type MetadataValue = string | number | boolean | Array<string | number | boolean>;

export interface RowOrigin {
  frameIndex: number;
  rowIndex: number;
  refId?: string;
  frameName?: string;
}

export interface ValidationDiagnostic extends RowOrigin {
  key?: string;
  field: string;
  reason: string;
}

export type SearchField = 'all' | 'key' | 'summary' | 'status' | 'assignee' | 'type' | `field:${string}`;

export interface SearchFieldOption {
  value: Exclude<SearchField, 'all'>;
  field: string;
  label: string;
}

export const defaults: JiraOptions = {
  rootKey: '', initialDepth: 2, staleHours: 24, jiraBaseUrl: '',
  maxIssues: 10000, rowHeight: 36, labelWidth: 420, searchableFields: '',
  fieldMappings: {}, sourceFields: '', metadataFields: '', issueUrlField: '', colorField: '',
  collapseMode: 'parent-or-descendants',
};

export interface JiraDataLink {
  target_key: string;
  type: string;
  display?: string | null;
  direction: LinkDirection;
}

/**
 * Complete observation using the default field mappings, in table fields or a logs row's `labels`.
 * Supply at least one of sync_ts, _time or Time, and resolved_at when resolved.
 */
export interface JiraDataRow {
  issue_key: string;
  created_at: string | number;
  is_resolved: boolean | 'true' | 'false';
  sync_ts?: string | number | null;
  _time?: string | number | null;
  Time?: string | number | null;
  resolved_at?: string | number | null;
  parent_key?: string | null;
  project_key?: string | null;
  summary?: string | null;
  issue_type?: string | null;
  status?: string | null;
  status_category?: string | null;
  assignee?: string | null;
  priority?: string | null;
  issue_links?: JiraDataLink[] | string | null;
  app?: string | null;
  instance?: string | null;
  environment?: string | null;
  [field: string]: unknown;
}

export interface Issue {
  id: string;
  source: string;
  key: string;
  parentKey: string;
  project: string;
  summary: string;
  type: string;
  status: string;
  category: string;
  assignee: string;
  priority: string;
  start: number;
  end: number;
  observed: number;
  resolved: boolean;
  links: IssueLink[];
  fields: Record<string, unknown>;
  metadata: Record<string, MetadataValue>;
  origin: RowOrigin;
  searchValues: Partial<Record<Exclude<SearchField, 'all'>, string[]>>;
}

export interface IssueLink {
  targetKey: string;
  type: string;
  display: string;
  direction: LinkDirection;
}

export interface IssueNode {
  issue: Issue;
  parent?: string;
  children: string[];
  warning?: string;
}

export interface TreeRow {
  node: IssueNode;
  depth: number;
  expanded: boolean;
  hasChildren: boolean;
  context: boolean;
}

export interface Rollup {
  descendants: number;
  doneDescendants: number;
  staleDescendants: number;
}

export interface Relationship {
  fromId: string;
  toId: string;
  fromRow: number;
  toRow: number;
  label: string;
  directed: boolean;
}
