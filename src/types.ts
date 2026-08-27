/**
 * TypeScript definitions mirroring the TMetric REST API v3 payloads that this
 * server consumes. Field names and nullability follow the official OpenAPI
 * document (TMetric REST API 3.2.1).
 */

export interface TMetricClientBasic {
  id?: number;
  name?: string;
  iconUrl?: string;
}

export interface TMetricProjectBasic {
  id?: number;
  name?: string;
  iconUrl?: string;
  client?: TMetricClientBasic;
  status?: string;
  isBillable?: boolean;
}

/** A project as returned by GET /timeentries/projects. */
export interface TMetricTimeEntryProject extends TMetricProjectBasic {
  recentUsageTime?: string | null;
}

export interface TMetricExternalLink {
  caption: string;
  iconUrl: string;
  link: string;
  issueId: string;
}

export interface TMetricTaskBasic {
  id?: number;
  name?: string;
  externalLink?: TMetricExternalLink;
}

export interface TMetricTagBasic {
  id?: number;
  name?: string;
  isWorkType?: boolean;
}

/** A tag as returned by GET /timeentries/tags. */
export interface TMetricTimeEntryTag extends TMetricTagBasic {
  isWorkTypeBillable?: boolean;
}

export interface TMetricTimeEntry {
  id?: number;
  /** Local (workspace) time without a UTC offset, e.g. "2026-08-20T09:00:00". */
  startTime?: string | null;
  /** Local time without a UTC offset. `null` means the timer is still running. */
  endTime?: string | null;
  task?: TMetricTaskBasic;
  project?: TMetricProjectBasic;
  note?: string;
  tags?: TMetricTagBasic[];
  isBillable?: boolean;
  isInvoiced?: boolean;
}

export interface TMetricRecentTimeEntry {
  task?: TMetricTaskBasic;
  project?: TMetricProjectBasic;
  note?: string;
  tags?: TMetricTagBasic[];
  isBillable?: boolean;
  isPinned?: boolean;
}

export interface TMetricTask {
  id?: number;
  name?: string;
  description?: string;
  project?: TMetricProjectBasic;
  assignee?: TMetricUserBasic;
  isCompleted?: boolean;
  dueDate?: string | null;
  tags?: TMetricTagBasic[];
  externalLink?: TMetricExternalLink;
}

export interface TMetricUserBasic {
  id: number;
  name?: string;
  iconUrl?: string;
}

export interface TMetricUserAccount {
  id: number;
  name?: string;
  firstWeekDay?: number;
  timeTracking?: {
    allowManualEditing?: boolean;
    allowNewProject?: boolean;
    allowNewClient?: boolean;
    allowNewTags?: boolean;
    allowNewTask?: boolean;
    requireDescription?: boolean;
    requireProject?: boolean;
    requireTags?: boolean;
    requireTask?: boolean;
    allowTeamView?: boolean;
  };
}

export interface TMetricUser {
  id: number;
  name?: string;
  email?: string;
  activeAccountId?: number;
  dateFormat?: string;
  timeFormat?: string;
  iconUrl?: string;
  timeZone?: { ianaId?: string; displayName?: string } | null;
  accounts?: TMetricUserAccount[];
}

/** One row of GET /reports/projects. */
export interface TMetricProjectReportItem {
  project: TMetricProjectBasic;
  totalSeconds: number;
  billableSeconds?: number;
  billableAmount?: number;
  billableCurrency?: string;
  costAmount?: number;
  costCurrency?: string;
  budget?: { total: number; spent: number; unit: string };
}
