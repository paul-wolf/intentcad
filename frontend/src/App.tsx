import { useEffect } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { useAuthStore } from '@/stores/authStore';
import { ProjectListPage } from '@/components/ProjectListPage';
import { DocumentListPage } from '@/components/DocumentListPage';
import { EditorPage } from '@/components/EditorPage';
import { LoginPage } from '@/components/LoginPage';
import { PasswordResetPage } from '@/components/PasswordResetPage';
import { ProtectedRoute } from '@/components/ProtectedRoute';
import { ProfilePage } from '@/components/ProfilePage';
import { UsersPage } from '@/components/UsersPage';
import { OrganisationsPage } from '@/components/OrganisationsPage';

export function App() {
  const checkAuth = useAuthStore((s) => s.checkAuth);

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/reset-password" element={<PasswordResetPage />} />
        <Route path="/" element={<ProtectedRoute><ProjectListPage /></ProtectedRoute>} />
        <Route path="/project/:projectId" element={<ProtectedRoute><DocumentListPage /></ProtectedRoute>} />
        <Route path="/edit/:id" element={<ProtectedRoute><EditorPage /></ProtectedRoute>} />
        <Route path="/profile" element={<ProtectedRoute><ProfilePage /></ProtectedRoute>} />
        <Route path="/manage/users" element={<ProtectedRoute requireStaff><UsersPage /></ProtectedRoute>} />
        <Route path="/manage/organisations" element={<ProtectedRoute requireSuperuser><OrganisationsPage /></ProtectedRoute>} />
      </Routes>
    </BrowserRouter>
  );
}
