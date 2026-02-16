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
}

export interface User {
  id: string;
  username: string;
  email: string;
  first_name: string;
  last_name: string;
  is_superuser: boolean;
  organisation: Organisation | null;
}

export interface UserDetail extends User {
  is_active: boolean;
  is_staff: boolean;
  date_joined: string;
  last_login: string | null;
  failed_login_attempts: number;
  locked_until: string | null;
}
