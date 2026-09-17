import { PanelPlugin } from '@grafana/data';
import { JiraPanel } from './JiraPanel';
import { defaults, type JiraOptions } from './types';

export const plugin = new PanelPlugin<JiraOptions>(JiraPanel).setPanelOptions((builder) => builder
  .addTextInput({ path: 'rootKey', name: 'Parent ticket', description: 'Optional root issue key. Supports dashboard variables. Blank shows every tree.', defaultValue: defaults.rootKey })
  .addTextInput({ path: 'jiraBaseUrl', name: 'Jira base URL', description: 'HTTP(S) URL, including any Jira context path. Prefer HTTPS. Used only for ticket links, never for fetching data.', defaultValue: defaults.jiraBaseUrl })
  .addTextInput({ path: 'searchableFields', name: 'Searchable fields', description: 'Optional comma-separated incoming field names, e.g. issue_key, summary, company. Blank enables built-in and discovered scalar fields. Applies to All fields too.', defaultValue: defaults.searchableFields })
  .addNumberInput({ path: 'initialDepth', name: 'Initially expanded levels', defaultValue: defaults.initialDepth, settings: { min: 0, max: 20, integer: true } })
  .addNumberInput({ path: 'staleHours', name: 'Stale after (hours)', description: 'Age of each last observation relative to now, including resolved tickets.', defaultValue: defaults.staleHours, settings: { min: 1, max: 8760 } })
  .addNumberInput({ path: 'maxIssues', name: 'Maximum issues', description: 'Query at least one extra row to detect truncation. Narrow queries rather than hiding partial trees.', defaultValue: defaults.maxIssues, settings: { min: 1, max: 50000, integer: true } })
  .addNumberInput({ path: 'rowHeight', name: 'Row height', defaultValue: defaults.rowHeight, settings: { min: 30, max: 60, integer: true } })
  .addNumberInput({ path: 'labelWidth', name: 'Ticket column width', defaultValue: defaults.labelWidth, settings: { min: 200, max: 700, integer: true } })
);
