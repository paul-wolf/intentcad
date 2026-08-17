import { useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useDocumentStore } from '@/stores/documentStore';
import { api } from '@/api/cachedClient';
import { migrateDocument } from '@/utils/document';
import type { Document } from '@/types/document';
import { startAutoSave, setBackendId, getBackendId, setProjectContext, getProjectId } from '@/api/autoSave';
import { projectApi } from '@/api/projectClient';
import { ScriptViewer } from './ScriptViewer';

/** First-class 3D part editor at /part/:id — loads the document and hosts the
 *  full-screen build123d editor directly (no 2D-sketch detour). */
export function PartEditorPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  // Load the document if navigated directly (mirrors EditorPage's loader).
  useEffect(() => {
    if (!id || getBackendId() === id) return;
    let cancelled = false;
    (async () => {
      try {
        const full = await api.getDocument(id);
        if (cancelled) return;
        useDocumentStore.getState().setDocument(migrateDocument(full.data as unknown as Document));
        const h = full.history as { undo?: unknown[]; redo?: unknown[] } | null;
        if (h && typeof h === 'object' && !Array.isArray(h) && h.undo) {
          useDocumentStore.getState().restoreHistory(h as never);
        }
        setBackendId(full.id);
        if (full.project_id) {
          projectApi.getProject(full.project_id)
            .then((p) => { if (!cancelled) setProjectContext(full.project_id, p.name); })
            .catch(() => {});
        } else {
          setProjectContext(null, null);
        }
      } catch (err) {
        console.error('Failed to load part:', err);
      }
    })();
    return () => { cancelled = true; };
  }, [id]);

  useEffect(() => startAutoSave(), []);

  const toProject = () => {
    const pid = getProjectId();
    navigate(pid ? `/project/${pid}` : '/');
  };

  return <ScriptViewer onClose={toProject} onHome={() => navigate('/')} onProject={toProject} />;
}
