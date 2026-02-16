import { Navigate } from 'react-router-dom';
import { useAuthStore } from '@/stores/authStore';
import { useThemeStore } from '@/theme';

interface Props {
  children: React.ReactNode;
  requireSuperuser?: boolean;
}

export function ProtectedRoute({ children, requireSuperuser }: Props) {
  const { user, loading } = useAuthStore();
  const palette = useThemeStore((s) => s.palette);

  if (loading) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100%',
          color: palette.textSecondary,
          fontSize: '14px',
        }}
      >
        Loading...
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  if (requireSuperuser && !user.is_superuser) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100%',
          color: palette.danger,
          fontSize: '14px',
        }}
      >
        Access denied. Admin privileges required.
      </div>
    );
  }

  return <>{children}</>;
}
