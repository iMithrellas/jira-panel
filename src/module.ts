import { FieldConfigProperty, PanelPlugin, type FieldOverrideContext } from '@grafana/data';
import { discoverInputFields } from './data';
import { JiraPanel } from './JiraPanel';
import { defaultFieldMappings, defaults, type IssueFieldMapping, type JiraOptions } from './types';

const inputFieldSettings = {
  options: [], allowCustomValue: true, isClearable: true,
  getOptions: async ({ data }: FieldOverrideContext) => discoverInputFields(data).map((value) => ({ value, label: value })),
};
const mappingLabels: Record<keyof IssueFieldMapping, string> = {
  key: 'Issue key', parent: 'Parent key', project: 'Project', summary: 'Summary', type: 'Issue type',
  status: 'Status', category: 'Status category', assignee: 'Assignee', priority: 'Priority',
  created: 'Created at', observed: 'Observed at', resolved: 'Resolved at', isResolved: 'Is resolved', links: 'Relationships',
};

export const plugin = new PanelPlugin<JiraOptions>(JiraPanel)
  .useFieldConfig({
    disableStandardOptions: [FieldConfigProperty.Actions, FieldConfigProperty.Filterable, FieldConfigProperty.NoValue],
    standardOptions: { [FieldConfigProperty.Color]: { settings: { byValueSupport: true } } },
  })
  .setPanelOptions((builder) => {
    builder
      .addTextInput({ path: 'rootKey', name: 'Parent ticket', description: 'Optional root issue key. Supports dashboard variables. Blank shows every tree.', defaultValue: defaults.rootKey })
      .addTextInput({ path: 'jiraBaseUrl', name: 'Jira base URL', description: 'Fallback HTTP(S) URL, including any Jira context path. Key-field data links and Ticket URL field take precedence. Supports dashboard variables.', defaultValue: defaults.jiraBaseUrl, category: ['Links and display'] })
      .addSelect({ path: 'issueUrlField', name: 'Ticket URL field', description: 'Optional field containing a complete HTTP(S) ticket URL per row, including labels-only rows. Missing or invalid URLs do not fall back to another site.', defaultValue: defaults.issueUrlField, settings: inputFieldSettings, category: ['Links and display'] })
      .addSelect({ path: 'colorField', name: 'Color by field', description: 'Use this flat field’s Grafana value mappings, thresholds or color scheme for bars. Blank uses Jira status categories.', defaultValue: defaults.colorField, settings: inputFieldSettings, category: ['Links and display'] })
      .addTextInput({ path: 'searchableFields', name: 'Searchable fields', description: 'Optional comma-separated incoming field names, e.g. issue_key, summary, company. Blank enables built-in and discovered scalar fields. Applies to All fields too.', defaultValue: defaults.searchableFields })
      .addTextInput({ path: 'metadataFields', name: 'Additional detail and export fields', description: 'Optional comma-separated incoming custom field names. Blank includes all discovered scalar fields and scalar arrays. Exported as custom_fields with raw values.', defaultValue: defaults.metadataFields, category: ['Links and display'] })
      .addTextInput({ path: 'sourceFields', name: 'Source identity fields', description: 'Comma-separated fields identifying a source, e.g. jira_site, tenant. Configured fields require nonempty strings. Blank uses optional app, instance and environment.', defaultValue: defaults.sourceFields, category: ['Field mappings'] })
      .addSelect({ path: 'collapseMode', name: 'Collapse completed policy', defaultValue: defaults.collapseMode, settings: { options: [
        { value: 'parent-or-descendants', label: 'Resolved parent or all descendants resolved' },
        { value: 'parent', label: 'Resolved parent' },
        { value: 'subtree', label: 'Parent and all descendants resolved' },
      ] } })
      .addNumberInput({ path: 'initialDepth', name: 'Initially expanded levels', defaultValue: defaults.initialDepth, settings: { min: 0, max: 20, integer: true } })
      .addNumberInput({ path: 'staleHours', name: 'Stale after (hours)', description: 'Age of each last observation relative to now, including resolved tickets.', defaultValue: defaults.staleHours, settings: { min: 1, max: 8760 } })
      .addNumberInput({ path: 'maxIssues', name: 'Maximum issues', description: 'Query at least one extra row to detect truncation. Narrow queries rather than hiding partial trees.', defaultValue: defaults.maxIssues, settings: { min: 1, max: 50000, integer: true } })
      .addNumberInput({ path: 'rowHeight', name: 'Row height', defaultValue: defaults.rowHeight, settings: { min: 30, max: 60, integer: true } })
      .addNumberInput({ path: 'labelWidth', name: 'Ticket column width', defaultValue: defaults.labelWidth, settings: { min: 200, max: 700, integer: true } });
    for (const key of Object.keys(defaultFieldMappings) as Array<keyof IssueFieldMapping>) {
      builder.addSelect({
        path: `fieldMappings.${key}`, name: mappingLabels[key], category: ['Field mappings'],
        description: key === 'observed' ? 'Incoming field name. The default sync_ts falls back to _time or Time when absent; custom fields do not fall back.'
          : `Incoming field name; select a field or enter a labels key. Blank uses ${defaultFieldMappings[key]}.`,
        defaultValue: defaultFieldMappings[key], settings: inputFieldSettings,
      });
    }
    return builder;
  });
