export interface JiraOptions {
  rootKey: string;
  initialDepth: number;
  staleHours: number;
  jiraBaseUrl: string;
  maxIssues: number;
  rowHeight: number;
  labelWidth: number;
  searchableFields: string;
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
};

export interface JiraDataLink {
  target_key: string;
  type: string;
  display?: string;
  direction: 'inward' | 'outward';
}

/**
 * Datasource-neutral row shape. Grafana table fields, or fields nested in a
 * logs frame's `labels` object, are validated against this contract at runtime.
 * At least one observation time is required; resolved_at is required when resolved.
 */
export interface JiraDataRow {
  issue_key: string;
  created_at: string | number;
  is_resolved: boolean | 'true' | 'false';
  sync_ts?: string | number;
  _time?: string | number;
  Time?: string | number;
  resolved_at?: string | number;
  parent_key?: string;
  project_key?: string;
  summary?: string;
  issue_type?: string;
  status?: string;
  status_category?: string;
  assignee?: string;
  priority?: string;
  issue_links?: JiraDataLink[] | string;
  app?: string;
  instance?: string;
  environment?: string;
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
  searchValues: Partial<Record<Exclude<SearchField, 'all'>, string[]>>;
}

export interface IssueLink {
  targetKey: string;
  type: string;
  display: string;
  direction: 'inward' | 'outward';
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
}
