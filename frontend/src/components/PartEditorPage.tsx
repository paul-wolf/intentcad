import { useEffect, useState, useSyncExternalStore } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useDocumentStore } from '@/stores/documentStore';
import { api } from '@/api/cachedClient';
import { migrateDocument } from '@/utils/document';
import type { Document } from '@/types/document';
import { startAutoSave, setBackendId, getBackendId, setProjectContext, getProjectId, subscribeBackendId, flushSave } from '@/api/autoSave';
import { projectApi } from '@/api/projectClient';
import { ScriptViewer } from './ScriptViewer';

/** First-class 3D part editor at /part/:id — loads the document and hosts the
 *  full-screen build123d editor directly (no 2D-sketch detour). */
export function PartEditorPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const backendId = useSyncExternalStore(subscribeBackendId, getBackendId);
  const [failedId, setFailedId] = useState<string | null>(null);

  // Load the document if navigated directly, or by Back/Forward from another
  // part (mirrors EditorPage's loader).
  useEffect(() => {
    if (!id || getBackendId() === id) return;
    flushSave();   // the last edit of the part being left goes to that part
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
          setProjectContext(full.project_id, null);   // not another part's project while the name loads
          projectApi.getProject(full.project_id)
            .then((p) => { if (!cancelled) setProjectContext(full.project_id, p.name); })
            .catch(() => {});
        } else {
          setProjectContext(null, null);
        }
      } catch (err) {
        console.error('Failed to load part:', err);
        if (!cancelled) setFailedId(id);
      }
    })();
    return () => { cancelled = true; };
  }, [id]);

  useEffect(() => startAutoSave(), []);

  const toProject = () => {
    const pid = getProjectId();
    navigate(pid ? `/project/${pid}` : '/');
  };

  // The editor reads the part's code once, when it mounts: show it only once
  // this part has loaded, and a fresh one per part, so it never holds another
  // part's model (which an edit would then save over this one). A part that
  // couldn't load (not saved yet) opens as before.
  if (backendId !== id && failedId !== id) return null;
  return <ScriptViewer key={id} onClose={toProject} onHome={() => navigate('/')} onProject={toProject} sketchOnFace />;
}
