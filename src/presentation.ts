import type { DataFrame, GrafanaTheme2, LinkModel } from '@grafana/data';
import { fieldLabel } from './data';
import { jiraLink } from './model';
import type { Issue } from './types';

export function presentField(frame: DataFrame | undefined, issue: Issue, name: string, label = fieldLabel(name)) {
  const field = frame?.fields.find((field) => field.name === name);
  const value = issue.fields[name];
  const scalar = (value: unknown) => typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));
  const display = scalar(value) ? field?.display?.(value) : undefined;
  const configuredName = field?.config.displayName || field?.config.displayNameFromDS;
  return {
    label: configuredName ? field?.state?.displayName || configuredName : label,
    text: display ? `${display.prefix ?? ''}${display.text}${display.suffix ?? ''}`
      : scalar(value) ? String(value) : Array.isArray(value) && value.every(scalar) ? value.join(', ') : '',
    color: display?.color,
  };
}

export function categoryColor(category: string, theme: GrafanaTheme2): string {
  return category === 'done' ? theme.colors.success.main
    : category === 'indeterminate' ? theme.colors.info.main
      : category === 'new' ? theme.colors.text.secondary : theme.colors.warning.main;
}

function safeUrl(value: unknown, allowRelative = false): string | undefined {
  if (typeof value !== 'string' || !value.trim()) { return undefined; }
  const href = value.trim();
  try {
    if (allowRelative && /^\/(?![\/\\])/.test(href) && !/[\x00-\x1f\\]/.test(href)) { return href; }
    const url = new URL(href);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : undefined;
  } catch { return undefined; }
}

export function ticketLinks(frame: DataFrame | undefined, issue: Issue, options: { keyField: string; urlField?: string; baseUrl?: string }): { links: LinkModel[]; warning?: string } {
  const keyField = frame?.fields.find((field) => field.name === options.keyField);
  const nativeLinks = keyField?.getLinks?.({ valueRowIndex: issue.origin.rowIndex }) ?? [];
  if (nativeLinks.length || keyField?.config.links?.length) {
    const links = nativeLinks.flatMap((link) => {
      const href = safeUrl(link.href, true);
      return href ? [{ ...link, href }] : [];
    });
    return { links, warning: links.length < nativeLinks.length || !links.length ? 'Some configured data links could not be displayed. Use HTTP(S) or root-relative Grafana URLs without credentials.' : undefined };
  }
  if (options.urlField?.trim()) {
    const field = options.urlField.trim();
    const href = safeUrl(issue.fields[field]);
    return href ? { links: [{ href, title: 'Open ticket', target: '_blank', origin: issue }] }
      : { links: [], warning: `Ticket URL field ${field} is missing or invalid. Supply a complete HTTP(S) URL without credentials.` };
  }
  const href = jiraLink(options.baseUrl ?? '', issue.key);
  return { links: href ? [{ href, title: 'Open in Jira', target: '_blank', origin: issue }] : [] };
}
