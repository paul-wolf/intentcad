export interface Project {
  id: string;
  name: string;
  description: string;
  updated_at: string;
  document_count: number;
}

export interface ProjectDetail {
  id: string;
  name: string;
  description: string;
  created_at: string;
  updated_at: string;
  /** Markdown every part's AI reads first: what the project is, materials, constraints */
  brief?: string;
  brief_updated_at?: string | null;
}

export interface BriefVersion {
  id: string;
  text: string;
  label: string;
  created_at: string;
  created_by: string;
}

export interface ProjectShare {
  id: string;
  email: string;
  username: string;
  shared_at: string;
}
