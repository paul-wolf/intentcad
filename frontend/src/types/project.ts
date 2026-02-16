export interface Project {
  id: string;
  name: string;
  description: string;
  updated_at: string;
  document_count: number;
  part_count: number;
}

export interface ProjectDetail {
  id: string;
  name: string;
  description: string;
  created_at: string;
  updated_at: string;
}
