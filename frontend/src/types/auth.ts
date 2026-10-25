export interface Organisation {
  id: string;
  name: string;
  slug: string;
}

export interface OrganisationDetail extends Organisation {
  description: string;
  email: string;
  phone: string;
  website: string;
  is_active: boolean;
  user_count: number;
  examples_note?: string | null;   // on create: the examples added, or why not
}

/** A project that can be copied into new organisations as their examples. */
export interface ExampleProject {
  id: string;
  name: string;
  organisation: string;
  document_count: number;
}

export interface ExamplesSetting {
  project: ExampleProject | null;
  choices: ExampleProject[];
}

export interface ExamplesAdded {
  project_id: string;
  name: string;
  document_count: number;
  message: string;
}

export interface User {
  id: string;
  username: string;
  email: string;
  first_name: string;
  last_name: string;
  is_staff: boolean;
  is_superuser: boolean;
  organisation: Organisation | null;
  date_joined?: string | null;
  last_login?: string | null;
}

export interface UserDetail extends User {
  is_active: boolean;
  is_staff: boolean;
  date_joined: string;
  last_login: string | null;
  failed_login_attempts: number;
  locked_until: string | null;
}

export type UserEventKind = 'login' | 'login_failed' | 'logout' | 'document_created' | 'ai_call';

export interface UserEvent {
  id: number;
  kind: UserEventKind;
  at: string;
  user_id: string | null;
  user_email: string;
  user_name: string;
  ip_address: string | null;
  user_agent: string;
  document_id: string;
  document_name: string;
  document_kind: '' | 'part' | 'sketch';
  text: string;
  cost_usd: number;
  detail: {
    source?: string; model?: string; failed?: boolean; backfilled?: boolean;
    tokens_in?: number; tokens_out?: number; cache_read_tokens?: number; cache_write_tokens?: number;
  };
}

export interface UserEventTotals {
  user_id: string;
  email: string;
  name: string;
  organisation: string;
  ai_calls: number;
  cost_usd: number;
  logins: number;
  documents_created: number;
  last_at: string | null;
}

export interface UserEventList {
  total: number;
  events: UserEvent[];
  spend: { cost_usd: number; ai_calls: number };
  by_user: UserEventTotals[];
  users: { id: string; email: string; name: string }[];
}

export interface UserEventQuery {
  q?: string;
  kind?: string;
  user?: string;
  since?: string;
  until?: string;
  offset?: number;
  limit?: number;
}
