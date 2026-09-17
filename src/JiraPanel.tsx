import { css } from '@emotion/css';
import { dateTimeFormat, type GrafanaTheme2, type PanelProps } from '@grafana/data';
import { useStyles2, useTheme2 } from '@grafana/ui';
import { useDeferredValue, useEffect, useId, useMemo, useRef, useState, type MouseEvent } from 'react';
import { barPosition, buildRelationships, buildTree, collapseCompleted, computeRollups, discoverSearchFields, expansionForDepth, exportRecords, fitRange, jiraLink, readIssues, recordsToCsv, selectRows } from './model';
import { defaults, type Issue, type JiraOptions, type SearchField } from './types';

const clamp = (value: number | undefined, fallback: number, min: number, max: number) =>
  Number.isFinite(value) ? Math.max(min, Math.min(max, Number(value))) : fallback;

export function JiraPanel({ data, options, width, height, timeZone, replaceVariables }: PanelProps<JiraOptions>) {
  const theme = useTheme2();
  const styles = useStyles2(getStyles);
  const configuredRoot = replaceVariables(options.rootKey ?? defaults.rootKey);
  const [root, setRoot] = useState(configuredRoot);
  const [rootSource, setRootSource] = useState<string>();
  const [search, setSearch] = useState('');
  const [searchField, setSearchField] = useState<SearchField>('all');
  const deferredSearch = useDeferredValue(search);
  const [projects, setProjects] = useState<string[]>([]);
  const [expansion, setExpansion] = useState(new Map<string, boolean>());
  const [rangeOverride, setRangeOverride] = useState<[number, number]>();
  const [selectedID, setSelectedID] = useState<string>();
  const [hoveredRelationship, setHoveredRelationship] = useState<string>();
  const [showRelationships, setShowRelationships] = useState(true);
  const [matchCursor, setMatchCursor] = useState(0);
  const [clock, setClock] = useState(Date.now());
  const [scroll, setScroll] = useState({ top: 0, left: 0, height: 400 });
  const viewport = useRef<HTMLDivElement>(null);
  const arrowMarkerId = `jira-arrow-${useId().replaceAll(':', '')}`;
  const rowHeight = Math.round(clamp(options.rowHeight, defaults.rowHeight, 30, 60));
  const maxIssues = Math.round(clamp(options.maxIssues, defaults.maxIssues, 1, 50000));
  const initialDepth = Math.round(clamp(options.initialDepth, defaults.initialDepth, 0, 20));
  const staleMs = clamp(options.staleHours, defaults.staleHours, 1, 8760) * 3600000;
  const [depthControl, setDepthControl] = useState(initialDepth);

  // Cache the O(n) data work so scrolling only renders the small virtual window.
  const parsed = useMemo(() => readIssues(data.series, maxIssues), [data.series, maxIssues]);
  const searchFieldOptions = useMemo(() => discoverSearchFields(parsed.issues, options.searchableFields), [parsed.issues, options.searchableFields]);
  const activeSearchField = searchFieldOptions.some(({ value }) => value === searchField) ? searchField : 'all';
  const tree = useMemo(() => buildTree(parsed.issues), [parsed.issues]);
  const rollups = useMemo(() => computeRollups(tree, clock, staleMs), [tree, clock, staleMs]);
  const selection = useMemo(() => selectRows(tree, root, deferredSearch, projects, expansion, initialDepth, rootSource, activeSearchField, searchFieldOptions),
    [tree, root, deferredSearch, projects, expansion, initialDepth, rootSource, activeSearchField, searchFieldOptions]);
  const availableProjects = useMemo(() => [...new Set(parsed.issues.map((issue) => issue.project))].filter(Boolean).sort(), [parsed.issues]);
  const sourceCount = useMemo(() => new Set(parsed.issues.map((issue) => issue.source)).size, [parsed.issues]);
  const fittedRange = useMemo(() => fitRange(selection.issues), [selection.issues]);
  const range = rangeOverride ?? fittedRange;
  const selected = selectedID ? tree.nodes.get(selectedID)?.issue : undefined;
  const innerWidth = Math.max(760, width - 2);
  const labelWidth = Math.min(innerWidth * 0.55, clamp(options.labelWidth, defaults.labelWidth, 200, 700));
  const timelineWidth = innerWidth - labelWidth;
  const windowSize = Math.ceil(scroll.height / rowHeight) + 12;
  const first = Math.max(0, Math.min(Math.floor(scroll.top / rowHeight) - 6, selection.rows.length - windowSize));
  const visibleRows = selection.rows.slice(first, first + windowSize);
  const relationships = useMemo(() => buildRelationships(tree, selection.rows), [tree, selection.rows]);
  const relationshipStart = Math.max(0, first - 6);
  const relationshipEnd = first + windowSize + 6;
  const visibleRelationships = relationships.filter((relationship) =>
    Math.max(relationship.fromRow, relationship.toRow) >= relationshipStart && Math.min(relationship.fromRow, relationship.toRow) <= relationshipEnd);
  const stats = useMemo(() => {
    let stale = 0;
    let lastSeen = 0;
    let earliestSeen = Infinity;
    let warnings = 0;
    for (const issue of selection.issues) {
      if (clock - issue.observed > staleMs) { stale++; }
      lastSeen = Math.max(lastSeen, issue.observed);
      earliestSeen = Math.min(earliestSeen, issue.observed);
      if (tree.nodes.get(issue.id)?.warning) { warnings++; }
    }
    return { stale, lastSeen, earliestSeen, warnings };
  }, [selection.issues, clock, staleMs, tree]);

  useEffect(() => { setRoot(configuredRoot); setRootSource(undefined); }, [configuredRoot]);
  useEffect(() => { setSearchField(activeSearchField); }, [activeSearchField]);
  useEffect(() => {
    setExpansion(new Map());
    setRangeOverride(undefined);
    setSelectedID(undefined);
    setDepthControl(initialDepth);
  }, [root, rootSource, initialDepth]);
  useEffect(() => {
    if (viewport.current) { viewport.current.scrollTop = 0; }
    setScroll((previous) => ({ ...previous, top: 0 }));
    setMatchCursor(0);
  }, [root, rootSource, deferredSearch, projects, activeSearchField, searchFieldOptions]);
  useEffect(() => {
    const element = viewport.current;
    if (!element) { return; }
    const observer = new ResizeObserver(() => setScroll((previous) => ({ ...previous, height: element.clientHeight })));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const interval = setInterval(() => setClock(Date.now()), 60000);
    return () => clearInterval(interval);
  }, []);
  useEffect(() => {
    if (!showRelationships) { setHoveredRelationship(undefined); }
  }, [showRelationships]);

  const format = (value: number, short = false) => dateTimeFormat(value, {
    timeZone, format: short ? (range[1] - range[0] < 3 * 86400000 ? 'MMM D HH:mm' : 'MMM D, YYYY') : 'YYYY-MM-DD HH:mm:ss',
  });
  const color = (issue: Issue) => issue.category === 'done' ? theme.colors.success.main
    : issue.category === 'indeterminate' ? theme.colors.info.main
      : issue.category === 'new' ? theme.colors.text.secondary : theme.colors.warning.main;
  const duration = (issue: Issue) => `${((issue.end - issue.start) / 86400000).toLocaleString(undefined, { maximumFractionDigits: 1 })}d`;
  const relationshipBranches = new Map<string, number>();
  const relationshipVisuals = visibleRelationships.flatMap((relationship, index) => {
    const fromIssue = tree.nodes.get(relationship.fromId)?.issue;
    const toIssue = tree.nodes.get(relationship.toId)?.issue;
    const fromPosition = fromIssue && barPosition(fromIssue.start, fromIssue.end, range);
    const toPosition = toIssue && barPosition(toIssue.start, toIssue.end, range);
    if (!fromIssue || !toIssue || !fromPosition || !toPosition) { return []; }

    const branch = relationshipBranches.get(relationship.fromId) ?? 0;
    relationshipBranches.set(relationship.fromId, branch + 1);
    const sourceLeft = labelWidth + fromPosition.left / 100 * timelineWidth;
    const targetLeft = labelWidth + toPosition.left / 100 * timelineWidth;
    const startX = sourceLeft + branch * 16;
    const laneX = Math.min(startX, targetLeft - 28);
    const endX = targetLeft;
    const startY = relationship.fromRow * rowHeight + rowHeight * 0.78;
    const endY = relationship.toRow * rowHeight + rowHeight / 2;
    const corner = 8;
    const verticalEnd = endY >= startY ? endY - corner : endY + corner;
    const points: Array<[number, number]> = [[startX, startY], [laneX, startY], [laneX, verticalEnd], [laneX + corner, endY], [endX, endY]];
    const badgeWidth = Math.max(42, relationship.label.length * 5.8 + 14);
    const labelX = Math.max(labelWidth + badgeWidth / 2 + 6, endX - badgeWidth / 2 - 10);
    const labelY = (startY + endY) / 2 - 9;
    const relationshipID = `${relationship.fromId}-${relationship.toId}-${relationship.label}`;
    const path = `M ${startX} ${startY} H ${laneX} V ${verticalEnd} Q ${laneX} ${endY} ${laneX + corner} ${endY} H ${endX}`;
    return [{
      ...relationship,
      id: relationshipID,
      color: color(toIssue),
      markerId: `${arrowMarkerId}-${index}`,
      points,
      path,
      labelX,
      labelY,
      labelWidth: badgeWidth,
    }];
  });
  const handleViewportMouseMove = (event: MouseEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left + event.currentTarget.scrollLeft;
    const y = event.clientY - rect.top + event.currentTarget.scrollTop;
    let closest: { id: string; distance: number } | undefined;
    for (const relationship of relationshipVisuals) {
      for (let pointIndex = 1; pointIndex < relationship.points.length; pointIndex++) {
        const [previousX, previousY] = relationship.points[pointIndex - 1];
        const [pointX, pointY] = relationship.points[pointIndex];
        const segmentX = pointX - previousX;
        const segmentY = pointY - previousY;
        const segmentLength = segmentX ** 2 + segmentY ** 2;
        const projection = segmentLength ? Math.max(0, Math.min(1, ((x - previousX) * segmentX + (y - previousY) * segmentY) / segmentLength)) : 0;
        const distance = Math.hypot(x - (previousX + projection * segmentX), y - (previousY + projection * segmentY));
        if (distance <= 10 && (!closest || distance < closest.distance)) { closest = { id: relationship.id, distance }; }
      }
    }
    setHoveredRelationship(closest?.id);
  };
  const toggle = (id: string, expanded: boolean) => setExpansion((previous) => new Map(previous).set(id, !expanded));
  const expandThroughDepth = () => setExpansion(expansionForDepth(tree, root, Math.round(clamp(depthControl, initialDepth, 0, 100)), rootSource));
  const collapseFinished = () => setExpansion(collapseCompleted(tree, rollups));
  const zoom = (factor: number) => {
    const center = (range[0] + range[1]) / 2;
    const half = Math.max(60000, Math.min(10 * 365 * 86400000, (range[1] - range[0]) * factor)) / 2;
    setRangeOverride([center - half, center + half]);
  };
  const pan = (direction: number) => {
    const shift = (range[1] - range[0]) * 0.25 * direction;
    setRangeOverride([range[0] + shift, range[1] + shift]);
  };
  const link = selected ? jiraLink(replaceVariables(options.jiraBaseUrl ?? ''), selected.key) : undefined;
  const download = (format: 'csv' | 'json') => {
    const records = exportRecords(selection.exportRows, rollups);
    const body = format === 'csv' ? recordsToCsv(records) : JSON.stringify(records, null, 2) + '\n';
    const blob = new Blob([body], { type: format === 'csv' ? 'text/csv;charset=utf-8' : 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    const scope = (root || 'all-tickets').replace(/[^a-z0-9_-]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'tickets';
    anchor.href = url;
    anchor.download = `jira-${scope}.${format}`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };
  const jumpToMatch = (direction: number) => {
    if (!selection.matchingIds.length) { return; }
    const next = (matchCursor + direction + selection.matchingIds.length) % selection.matchingIds.length;
    const id = selection.matchingIds[next];
    setMatchCursor(next);
    setSelectedID(id);
    const rowIndex = selection.rows.findIndex((row) => row.node.issue.id === id);
    if (rowIndex >= 0 && viewport.current) { viewport.current.scrollTop = rowIndex * rowHeight; }
  };
  const ticks = Array.from({ length: 5 }, (_, i) => range[0] + (range[1] - range[0]) * i / 4);
  const warnings = [
    parsed.truncated ? `Partial result: limited to ${maxIssues.toLocaleString()} issues. Narrow the query; parents or children may be missing.` : '',
    parsed.invalid ? `${parsed.invalid} invalid row(s) excluded. Required: issue_key, created_at, observation time, is_resolved, and resolved_at when resolved.` : '',
    stats.warnings ? `${stats.warnings} missing or cyclic parent relationship(s); affected tickets remain visible.` : '',
    sourceCount > 1 ? `${sourceCount} source namespaces; relationships are isolated per source. Jira links use the configured base URL.` : '',
  ].filter(Boolean);

  return (
    <section className={styles.panel} style={{ width, height }} aria-label="Jira hierarchy timeline" onKeyDown={(event) => {
      if (event.key === 'Escape') { setSelectedID(undefined); }
    }}>
      <div className={styles.toolbar}>
        <label className={styles.rootLabel}>Parent
          <input aria-label="Parent ticket" placeholder="All ticket trees" value={root} onChange={(event) => { setRoot(event.target.value); setRootSource(undefined); }} />
        </label>
        <label className={styles.searchField}>Search in
          <select aria-label="Search field" value={activeSearchField} onChange={(event) => setSearchField(event.target.value as SearchField)}>
            <option value="all">All fields</option>
            {searchFieldOptions.map((option) => <option key={option.value} value={option.value} title={option.field}>{option.label}</option>)}
          </select>
        </label>
        <input className={styles.search} aria-label="Search tickets" placeholder={activeSearchField === 'all' ? 'Search all fields...' : `Search ${searchFieldOptions.find((option) => option.value === activeSearchField)?.label.toLowerCase()}...`} value={search} onChange={(event) => setSearch(event.target.value)} />
        <details className={styles.projects}>
          <summary>Projects {projects.length ? `(${projects.length})` : '(all)'}</summary>
          <div className={styles.projectMenu}>
            <button type="button" onClick={() => setProjects([])}>All projects</button>
            {availableProjects.map((project) => <label key={project}>
              <input type="checkbox" checked={projects.includes(project)} onChange={() => setProjects((previous) => previous.includes(project)
                ? previous.filter((p) => p !== project) : [...previous, project])} />{project}
            </label>)}
            <small>Ancestors are retained for context.</small>
          </div>
        </details>
        {deferredSearch && <div className={styles.matchNav} role="region" aria-label="Search result navigation">
          <button type="button" aria-label="Previous search match" disabled={!selection.matchingIds.length} onClick={() => jumpToMatch(-1)}>&lt;</button>
          <span>{selection.matchingIds.length ? `${matchCursor + 1}/${selection.matchingIds.length}` : '0 matches'}</span>
          <button type="button" aria-label="Next search match" disabled={!selection.matchingIds.length} onClick={() => jumpToMatch(1)}>&gt;</button>
        </div>}
      </div>
      <div className={styles.controls}>
        <div className={styles.actions}>
          <button type="button" disabled={selection.filtering} onClick={() => setExpansion(new Map([...tree.nodes.keys()].map((id) => [id, true])))}>Expand all</button>
          <button type="button" disabled={selection.filtering} onClick={() => setExpansion(new Map([...tree.nodes.keys()].map((id) => [id, false])))}>Collapse all</button>
          <label className={styles.depthControl}>Depth
            <input aria-label="Expand through depth" type="number" min={0} max={100} value={depthControl} onChange={(event) => setDepthControl(Math.max(0, Math.min(100, Number(event.target.value) || 0)))} />
          </label>
          <button type="button" disabled={selection.filtering} onClick={expandThroughDepth}>Expand to depth</button>
          <button type="button" disabled={selection.filtering} onClick={collapseFinished}>Collapse completed</button>
          <button type="button" aria-pressed={!showRelationships} onClick={() => setShowRelationships((visible) => !visible)}>{showRelationships ? 'Hide arrows' : 'Show arrows'}</button>
          <button type="button" aria-label="Export CSV" disabled={!selection.exportRows.length} onClick={() => download('csv')}>CSV</button>
          <button type="button" aria-label="Export JSON" disabled={!selection.exportRows.length} onClick={() => download('json')}>JSON</button>
          <span className={styles.count} data-testid="issue-count">{selection.matchingCount.toLocaleString()} tickets / {selection.rows.length.toLocaleString()} rows</span>
        </div>
        <div className={styles.actions}>
          <button type="button" aria-label="Pan earlier" onClick={() => pan(-1)}>&lt;</button>
          <button type="button" aria-label="Zoom in" onClick={() => zoom(0.5)}>+</button>
          <button type="button" aria-label="Zoom out" onClick={() => zoom(2)}>-</button>
          <button type="button" aria-label="Pan later" onClick={() => pan(1)}>&gt;</button>
          <button type="button" onClick={() => setRangeOverride(undefined)}>Fit tickets</button>
        </div>
      </div>
      <div className={styles.status}>
        <div className={styles.legend}>
          {(['new', 'indeterminate', 'done'] as const).map((category, i) => <span key={category}>
            <i style={{ background: color({ category } as Issue) }} />{['To do', 'In progress', 'Done'][i]}
          </span>)}
          <span className={styles.openLegend}>Open = last observed</span>
          {showRelationships && relationships.length > 0 && <span className={styles.relationshipLegend}><i />{relationships.length} {relationships.length === 1 ? 'dependency' : 'dependencies'}</span>}
          {rootSource && <span>Source: {JSON.parse(rootSource).filter(Boolean).join(' / ')}</span>}
        </div>
        {stats.lastSeen > 0 && <span title={`Observation range: ${format(stats.earliestSeen)} to ${format(stats.lastSeen)} (${timeZone})`}>
          Latest observation {format(stats.lastSeen)}{stats.stale > 0 && <strong className={styles.stale}> / {stats.stale.toLocaleString()} stale</strong>}
        </span>}
      </div>
      {warnings.length > 0 && <div role="status" className={styles.warning}>{warnings.join(' ')}</div>}
      {data.error && <div role="alert" className={styles.warning}>Query failed: {data.error.message}. Any displayed rows may be from the previous result.</div>}
      <div className={styles.axisClip}>
        <div className={styles.axis} style={{ width: innerWidth, transform: `translateX(${-scroll.left}px)` }}>
          <div style={{ width: labelWidth }} className={styles.axisTitle}>TICKET / SUMMARY</div>
          <div className={styles.ticks} style={{ width: timelineWidth }}>
            {ticks.map((tick, i) => <span key={i} style={{ left: `${i * 25}%`, transform: `translateX(${i === 0 ? 0 : i === 4 ? -100 : -50}%)` }}>{format(tick, true)}</span>)}
          </div>
        </div>
      </div>
      <div ref={viewport} className={styles.viewport} data-testid="jira-viewport" role="treegrid" aria-label="Jira tickets"
        onMouseMove={handleViewportMouseMove} onMouseLeave={() => setHoveredRelationship(undefined)}
        aria-rowcount={selection.rows.length} aria-colcount={2}
        onScroll={(event) => setScroll({ top: event.currentTarget.scrollTop, left: event.currentTarget.scrollLeft, height: event.currentTarget.clientHeight })}>
        <div style={{ height: selection.rows.length * rowHeight, width: innerWidth, position: 'relative' }}>
          {visibleRows.map(({ node, depth, hasChildren, expanded, context }, index) => {
            const issue = node.issue;
            const rollup = rollups.get(issue.id);
            const position = barPosition(issue.start, issue.end, range);
            const stale = clock - issue.observed > staleMs;
            const title = `${issue.key}: ${issue.summary}\n${issue.status} | ${issue.type} | ${issue.assignee || 'Unassigned'}\nCreated: ${format(issue.start)}\n${issue.resolved ? 'Resolved' : 'Last observed'}: ${format(issue.end)}\nLifetime: ${duration(issue)}${stale ? '\nStale observation' : ''}${node.warning ? `\n${node.warning}` : ''}`;
            return <div key={issue.id} role="row" aria-rowindex={first + index + 1} aria-level={depth + 1}
              aria-expanded={hasChildren ? expanded : undefined} aria-selected={selectedID === issue.id}
              data-testid="jira-row" data-issue-key={issue.key} className={styles.row}
              style={{ height: rowHeight, top: (first + index) * rowHeight, background: selectedID === issue.id ? theme.colors.action.selected : undefined }}>
              <div role="gridcell" className={styles.labelCell} style={{ width: labelWidth, paddingLeft: Math.min(depth, 12) * 16 + 8 }}>
                <button className={styles.expander} type="button" disabled={!hasChildren || selection.filtering} aria-label={`${expanded ? 'Collapse' : 'Expand'} ${issue.key}`}
                  style={{ visibility: hasChildren ? 'visible' : 'hidden' }} onClick={() => toggle(issue.id, expanded)}>{expanded ? 'v' : '>'}</button>
                <button type="button" className={styles.ticket} style={{ opacity: context ? 0.6 : 1 }} title={title} onClick={() => setSelectedID(issue.id)}>
                  <span className={styles.key}>{issue.key}</span><span className={styles.summary}>{issue.summary || '(no summary)'}</span>
                  {!!rollup?.descendants && <span className={styles.rollup} data-testid="rollup-badge" title={`${rollup.descendants} descendants, ${rollup.doneDescendants} done, ${rollup.staleDescendants} stale`}>{rollup.descendants} children / {rollup.doneDescendants} done{rollup.staleDescendants ? ` / ${rollup.staleDescendants} stale` : ''}</span>}
                </button>
                {(node.warning || stale) && <span className={styles.marker} title={node.warning || 'Stale observation'} aria-label={node.warning || 'Stale observation'}>!</span>}
              </div>
              <div role="gridcell" className={styles.lane} style={{ width: timelineWidth }}>
                {position ? <button type="button" aria-label={`Details for ${issue.key}`} title={title} className={styles.bar}
                  onClick={() => setSelectedID(issue.id)} style={{
                    left: `clamp(0px, ${position.left}%, calc(100% - 3px))`, width: `max(3px, ${position.width}%)`,
                    background: color(issue), opacity: stale ? 0.55 : 0.9,
                    borderRight: issue.resolved ? 'none' : `3px dashed ${theme.colors.background.primary}`,
                  }}>
                  <span>{issue.status} / {duration(issue)}</span>
                </button> : <span className={styles.outside}>Outside view</span>}
              </div>
            </div>;
          })}
          {showRelationships && <svg className={styles.links} width={innerWidth} height={selection.rows.length * rowHeight} viewBox={`0 0 ${innerWidth} ${selection.rows.length * rowHeight}`} aria-hidden="true">
            <defs>
              {relationshipVisuals.map((relationship) => <marker key={relationship.markerId} id={relationship.markerId} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="userSpaceOnUse">
                <path d="M0,0 L8,4 L0,8 z" fill={relationship.color} />
              </marker>)}
            </defs>
            {relationshipVisuals.map((relationship) => {
              const hovered = hoveredRelationship === relationship.id;
              return <g className={styles.relationshipArrow} key={relationship.id} data-testid="relationship-arrow">
                <title>{`${relationship.label}: ${tree.nodes.get(relationship.fromId)?.issue.key ?? ''} -> ${tree.nodes.get(relationship.toId)?.issue.key ?? ''}`}</title>
                <path className={styles.linkPath} d={relationship.path} stroke={relationship.color} markerEnd={`url(#${relationship.markerId})`} />
                <rect className={styles.linkLabelBox} style={{ opacity: hovered ? 1 : 0 }} x={relationship.labelX - relationship.labelWidth / 2} y={relationship.labelY - 9} width={relationship.labelWidth} height={18} rx={4} stroke={relationship.color} />
                <text className={styles.linkLabel} style={{ opacity: hovered ? 1 : 0 }} x={relationship.labelX} y={relationship.labelY}>{relationship.label}</text>
              </g>;
            })}
          </svg>}
        </div>
        {!selection.rows.length && <div className={styles.empty}>
          <strong>{data.state === 'Loading' ? 'Loading Jira tickets...' : 'No matching tickets'}</strong>
          <p>{!parsed.issues.length ? 'Query complete issue observations as a table or VictoriaLogs logs frame. Check the observation lookback and required fields.'
            : root && !selection.scopedCount ? `Parent ${root} is not in the result. Clear Parent to browse all trees; include the parent and every child project in the query.`
              : 'Clear search or project filters to see tickets.'}</p>
        </div>}
      </div>
      <div className={styles.footer}>
        <span>Actual Jira parents / observed lifetimes, not planned schedules</span>
        <span>{selection.filtering ? 'Matching tickets + ancestor context' : 'Timeline fits fetched tickets; zoom is local'}</span>
      </div>
      {selected && <aside className={styles.detail} aria-label={`Ticket details ${selected.key}`}>
        <div className={styles.detailHeader}><strong>{selected.key}</strong><button type="button" aria-label="Close ticket details" onClick={() => setSelectedID(undefined)}>Close</button></div>
        <h3>{selected.summary || '(no summary)'}</h3>
        <dl>
          {Object.entries({
            Status: selected.status || 'Unknown', Type: selected.type || 'Unknown', Project: selected.project,
            Parent: selected.parentKey || 'None', Assignee: selected.assignee || 'Unassigned', Priority: selected.priority || 'Not set',
            Created: format(selected.start), [selected.resolved ? 'Resolved' : 'Observed end']: format(selected.end),
            'Last observed': format(selected.observed), Lifetime: duration(selected),
            Children: rollups.get(selected.id)?.descendants ? `${rollups.get(selected.id)!.descendants} (${rollups.get(selected.id)!.doneDescendants} done${rollups.get(selected.id)!.staleDescendants ? `, ${rollups.get(selected.id)!.staleDescendants} stale` : ''})` : 'None',
            Source: JSON.parse(selected.source).filter(Boolean).join(' / ') || 'Unspecified',
          }).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
        </dl>
        {clock - selected.observed > staleMs && <p className={styles.stale}>Stale observation. Current Jira state may differ.</p>}
        {tree.nodes.get(selected.id)?.warning && <p className={styles.stale}>{tree.nodes.get(selected.id)?.warning}</p>}
        {selected.links.length > 0 && <div className={styles.relationships}>
          <strong>Relationships</strong>
          {selected.links.map((link) => <div key={`${link.direction}-${link.targetKey}-${link.type}`}><span>{link.display || link.type}</span> <code>{link.targetKey}</code></div>)}
        </div>}
        <div className={styles.actions}>
          <button type="button" onClick={() => { setRoot(selected.key); setRootSource(selected.source); setSearch(''); setProjects([]); }}>Focus subtree</button>
          {link && <a href={link} target="_blank" rel="noopener noreferrer">Open in Jira</a>}
        </div>
      </aside>}
    </section>
  );
}

function getStyles(theme: GrafanaTheme2) {
  const border = theme.colors.border.weak;
  return {
    panel: css({ display: 'flex', flexDirection: 'column', position: 'relative', minHeight: 0, fontSize: 12, color: theme.colors.text.primary,
      '& button, & input, & summary': { font: 'inherit' },
      '& button, & summary': { cursor: 'pointer' },
      '& button:disabled': { cursor: 'default', opacity: 0.4 },
      '& button:focus-visible, & input:focus-visible, & summary:focus-visible, & a:focus-visible': { outline: `2px solid ${theme.colors.primary.main}`, outlineOffset: -2 },
      '& button': { border: `1px solid ${border}`, borderRadius: 4, padding: '4px 8px', color: theme.colors.text.primary, background: theme.colors.background.secondary },
      '& input:not([type=checkbox]), & select': { border: `1px solid ${border}`, background: theme.colors.background.primary, color: theme.colors.text.primary, borderRadius: 4, padding: '6px 8px', minWidth: 0 },
    }),
    toolbar: css({ display: 'flex', flexWrap: 'wrap', gap: 8, padding: '8px 8px 4px', alignItems: 'center', flexShrink: 0 }),
    rootLabel: css({ display: 'flex', alignItems: 'center', gap: 8, '& input': { width: 130 } }),
    searchField: css({ display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap', flexShrink: 0, '& select': { width: 112, height: 28, boxSizing: 'border-box' } }),
    search: css({ flex: '1 1 210px' }),
    matchNav: css({ display: 'inline-flex', alignItems: 'center', gap: 4, color: theme.colors.text.secondary, whiteSpace: 'nowrap', '& button': { padding: '4px 7px' } }),
    projects: css({ position: 'relative', '& summary': { padding: 6 } }),
    projectMenu: css({ position: 'absolute', right: 0, top: '100%', zIndex: 5, minWidth: 210, maxHeight: 260, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 8, padding: 12, border: `1px solid ${border}`, borderRadius: 4, background: theme.colors.background.primary, boxShadow: theme.shadows.z2, '& label': { display: 'flex', gap: 8, alignItems: 'center' } }),
    controls: css({ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: 6, padding: '4px 8px 8px', flexShrink: 0 }),
    actions: css({ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 4 }),
    depthControl: css({ display: 'inline-flex', alignItems: 'center', gap: 4, color: theme.colors.text.secondary, '& input': { width: 46, textAlign: 'center' } }),
    count: css({ marginLeft: 8, color: theme.colors.text.secondary, fontVariantNumeric: 'tabular-nums' }),
    status: css({ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: 6, padding: '6px 10px', fontSize: 11, color: theme.colors.text.secondary, borderTop: `1px solid ${border}` }),
    legend: css({ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, '& span': { display: 'inline-flex', alignItems: 'center', gap: 4 }, '& i': { width: 7, height: 7, borderRadius: 2 } }),
    openLegend: css({ fontStyle: 'italic' }),
    relationshipLegend: css({ '& i': { width: 24, height: 0, borderTop: `2px solid ${theme.colors.text.secondary}`, position: 'relative', '&::after': { content: '""', position: 'absolute', right: -1, top: -4, borderTop: '3px solid transparent', borderBottom: '3px solid transparent', borderLeft: `5px solid ${theme.colors.text.secondary}` } } }),
    stale: css({ color: theme.colors.warning.text }),
    warning: css({ color: theme.colors.warning.text, background: theme.colors.warning.transparent, padding: '6px 10px', fontSize: 11, maxHeight: 64, overflow: 'auto', flexShrink: 0 }),
    axisClip: css({ overflow: 'hidden', flexShrink: 0, borderTop: `1px solid ${border}`, borderBottom: `1px solid ${border}` }),
    axis: css({ display: 'flex', height: 36, alignItems: 'center', color: theme.colors.text.secondary, fontSize: 10 }),
    axisTitle: css({ flexShrink: 0, padding: '0 12px', letterSpacing: '0.08em' }),
    ticks: css({ position: 'relative', height: '100%', '& span': { position: 'absolute', top: 10, whiteSpace: 'nowrap', padding: '0 4px' } }),
    viewport: css({ flex: '1 1 auto', minHeight: 60, overflow: 'auto', overscrollBehavior: 'contain', scrollbarGutter: 'stable' }),
    links: css({ position: 'absolute', top: 0, left: 0, zIndex: 2, overflow: 'visible', pointerEvents: 'none' }),
    linkPath: css({ fill: 'none', strokeWidth: 2, opacity: 0.95, pointerEvents: 'none' }),
    relationshipArrow: css({ cursor: 'help' }),
    linkLabelBox: css({ fill: theme.colors.background.primary, fillOpacity: 0.96, strokeWidth: 1.2, opacity: 0, transition: 'opacity 100ms ease' }),
    linkLabel: css({ fill: theme.colors.text.primary, fontSize: 10, fontWeight: 500, textAnchor: 'middle', dominantBaseline: 'middle', opacity: 0, transition: 'opacity 100ms ease', pointerEvents: 'none' }),
    row: css({ position: 'absolute', display: 'flex', width: '100%', borderBottom: `1px solid ${border}`, '&:hover': { background: theme.colors.action.hover } }),
    labelCell: css({ display: 'flex', flexShrink: 0, alignItems: 'center', gap: 3, paddingRight: 6, borderRight: `1px solid ${border}`, boxSizing: 'border-box', minWidth: 0 }),
    expander: css({ '&&': { width: 20, flexShrink: 0, padding: 0, border: 0, background: 'none', fontFamily: 'monospace', color: theme.colors.text.secondary } }),
    ticket: css({ '&&': { minWidth: 0, padding: 0, border: 0, background: 'none', display: 'flex', alignItems: 'center', gap: 8, textAlign: 'left', flex: 1 } }),
    key: css({ flexShrink: 0, fontFamily: theme.typography.fontFamilyMonospace, fontSize: 11, color: theme.colors.text.link }),
    summary: css({ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }),
    rollup: css({ flexShrink: 0, color: theme.colors.text.secondary, fontSize: 10, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }),
    marker: css({ fontSize: 10, color: theme.colors.warning.text, flexShrink: 0 }),
    lane: css({ position: 'relative', flexShrink: 0, backgroundImage: `linear-gradient(to right, ${border} 1px, transparent 1px)`, backgroundSize: '25% 100%' }),
    bar: css({ '&&': { position: 'absolute', top: '22%', height: '56%', padding: '0 6px', border: 0, borderRadius: 3, textAlign: 'left', color: theme.colors.getContrastText(theme.colors.info.main), overflow: 'hidden', whiteSpace: 'nowrap', fontSize: 10, minWidth: 3, boxSizing: 'border-box' }, '& span': { pointerEvents: 'none' } }),
    outside: css({ display: 'block', fontSize: 10, padding: '9px 8px', color: theme.colors.text.disabled }),
    empty: css({ padding: '32px 20px', maxWidth: 600, '& p': { color: theme.colors.text.secondary, marginTop: 8 } }),
    footer: css({ flexShrink: 0, display: 'flex', flexWrap: 'wrap', gap: 6, justifyContent: 'space-between', padding: '5px 10px', borderTop: `1px solid ${border}`, fontSize: 10, color: theme.colors.text.secondary }),
    detail: css({ position: 'absolute', top: 48, right: 8, bottom: 24, width: 360, maxWidth: 'calc(100% - 16px)', zIndex: 6, padding: 16, border: `1px solid ${border}`, borderRadius: 6, background: theme.colors.background.primary, boxShadow: theme.shadows.z3, overflow: 'auto', '& h3': { fontSize: 16, margin: '12px 0', overflowWrap: 'anywhere' }, '& dl': { margin: '12px 0' }, '& dl > div': { display: 'grid', gridTemplateColumns: '100px minmax(0, 1fr)', gap: 8, padding: '5px 0', borderBottom: `1px solid ${border}` }, '& dt': { color: theme.colors.text.secondary, fontWeight: 400 }, '& dd': { margin: 0, overflowWrap: 'anywhere' } }),
    detailHeader: css({ display: 'flex', justifyContent: 'space-between', alignItems: 'center', '& strong': { fontFamily: theme.typography.fontFamilyMonospace, color: theme.colors.text.link } }),
    relationships: css({ margin: '12px 0', padding: '8px 0', color: theme.colors.text.secondary, '& strong': { display: 'block', color: theme.colors.text.primary, marginBottom: 5 }, '& div': { padding: '3px 0' }, '& code': { color: theme.colors.text.link } }),
  };
}
