import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { DocumentListPage } from '@/components/DocumentListPage';
import { EditorPage } from '@/components/EditorPage';

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<DocumentListPage />} />
        <Route path="/edit/:id" element={<EditorPage />} />
      </Routes>
    </BrowserRouter>
  );
}
