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
