import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { DocumentListPage } from '@/components/DocumentListPage';
import { EditorPage } from '@/components/EditorPage';
import { PartEditorPage } from '@/components/PartEditorPage';

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<DocumentListPage />} />
        <Route path="/edit/:id" element={<EditorPage />} />
        <Route path="/part/:id" element={<PartEditorPage />} />
      </Routes>
    </BrowserRouter>
  );
}
