import { useEffect } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { useAuthStore } from '@/stores/authStore';
import { DocumentListPage } from '@/components/DocumentListPage';
import { EditorPage } from '@/components/EditorPage';
import { PartEditorPage } from '@/components/PartEditorPage';
import { LoginPage } from '@/components/LoginPage';
import { PasswordResetPage } from '@/components/PasswordResetPage';
import { ProtectedRoute } from '@/components/ProtectedRoute';
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
        <Route path="/" element={<ProtectedRoute><DocumentListPage /></ProtectedRoute>} />
        <Route path="/edit/:id" element={<ProtectedRoute><EditorPage /></ProtectedRoute>} />
        <Route path="/part/:id" element={<ProtectedRoute><PartEditorPage /></ProtectedRoute>} />
        <Route path="/admin/users" element={<ProtectedRoute requireSuperuser><UsersPage /></ProtectedRoute>} />
        <Route path="/admin/organisations" element={<ProtectedRoute requireSuperuser><OrganisationsPage /></ProtectedRoute>} />
      </Routes>
    </BrowserRouter>
  );
}
