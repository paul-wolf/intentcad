import type { Tool, ToolContext } from './types';
import type { Entity, LineEntity, Point } from '@/types/document';
import type { Renderer, Viewport } from '@/types/renderer';
import { useEditorStore } from '@/stores/editorStore';
import type { SelectedPoint } from '@/stores/editorStore';
import { useDocumentStore } from '@/stores/documentStore';
import { hitTestEntities, hitTestPoint, hitTestSegment, hitTestAllCandidates } from '@/hittest/hitTest';
import type { PointHit, SelectionCandidate } from '@/hittest/hitTest';
import { addLog } from '@/stores/logStore';
import { segmentIntersectsRect, circleIntersectsRect, rectIntersectsRect } from '@/utils/geometry';
import { getThemePalette } from '@/theme';
import { distance } from '@/utils/geometry';
import { requestSave } from '@/api/autoSave';
import { getEntityPoint, getEntityPoints } from '@/utils/entityPoints';
import { getSegmentCount, getSegmentPointIndices } from '@/utils/lineSegments';

const DRAG_THRESHOLD = 4; // screen pixels before starting drag

/** Resolve two segments: prefer explicit segment selection, fall back to entity selection for single-segment lines. */
function resolveTwoSegments(): { entityId: string; segmentIndex: number }[] | null {
  const es = useEditorStore.getState();
  if (es.selectedSegments.length === 2) return es.selectedSegments;
  // Fall back: if exactly 2 entities are selected and each has exactly 1 segment, use segment 0
  if (es.selectedEntityIds.size === 2) {
    const sketch = useDocumentStore.getState().getActiveSketch();
    if (!sketch) return null;
    const ids = [...es.selectedEntityIds];
    const segs: { entityId: string; segmentIndex: number }[] = [];
    for (const id of ids) {
      const entity = sketch.entities.find((e) => e.id === id);
      if (!entity || entity.type !== 'line') return null;
      if (getSegmentCount(entity) !== 1) return null;
      segs.push({ entityId: id, segmentIndex: 0 });
    }
    return segs;
  }
  return null;
}

export function createSelectTool(): Tool {
  let mouseDownScreen: Point | null = null;
  let dragStartWorld: Point | null = null;
  let dragEndWorld: Point | null = null;

  let hitEntityOnDown: Entity | null = null;
  let hitPointOnDown: PointHit | null = null;
  let dragMode: 'box-select' | 'move' | 'move-point' | null = null;
  let lastMoveWorld: Point | null = null;

  let lastClickTime = 0;
  let lastClickScreenPos: Point = { x: 0, y: 0 };
  let shiftOnDown = false;

  let cycleScreenPos: Point | null = null;
  let cycleCandidates: SelectionCandidate[] = [];
  let cycleIndex = -1;

  const applyCandidate = (c: SelectionCandidate) => {
    const es = useEditorStore.getState();
    if (c.kind === 'point') {
      es.setSelectedPoints([{ entityId: c.hit.entityId, pointIndex: c.hit.pointIndex }]);
      es.setSelectedSegments([]);
      es.setSelectedEntityIds(new Set());
    } else if (c.kind === 'segment') {
      es.setSelectedPoints([]);
      es.setSelectedSegments([c.hit]);
      es.setSelectedEntityIds(new Set([c.hit.entityId]));
    } else {
      es.setSelectedPoints([]);
      es.setSelectedSegments([]);
      es.setSelectedEntityIds(new Set([c.entity.id]));
    }
  };

  const logCandidate = (c: SelectionCandidate, index: number, total: number) => {
    const tag = `[${index + 1}/${total}]`;
    if (c.kind === 'point') {
      addLog('info', `Select: point ${c.hit.pointIndex} on ${c.entity.type}_${c.entity.id.slice(0, 6)} ${tag}`);
    } else if (c.kind === 'segment') {
      addLog('info', `Select: segment ${c.hit.segmentIndex} on ${c.entity.type}_${c.entity.id.slice(0, 6)} ${tag}`);
    } else {
      addLog('info', `Select: ${c.entity.type} ${c.entity.type}_${c.entity.id.slice(0, 6)} ${tag}`);
    }
  };

  const candidatesMatch = (a: SelectionCandidate[], b: SelectionCandidate[]): boolean => {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      const ca = a[i]!;
      const cb = b[i]!;
      if (ca.kind !== cb.kind) return false;
      if (ca.entity.id !== cb.entity.id) return false;
      if (ca.kind === 'point' && cb.kind === 'point') {
        if (ca.hit.pointIndex !== cb.hit.pointIndex) return false;
      }
      if (ca.kind === 'segment' && cb.kind === 'segment') {
        if (ca.hit.segmentIndex !== cb.hit.segmentIndex) return false;
      }
    }
    return true;
  };

  const resetDrag = () => {
    mouseDownScreen = null;
    dragStartWorld = null;
    dragEndWorld = null;
    hitEntityOnDown = null;
    hitPointOnDown = null;
    dragMode = null;
    lastMoveWorld = null;
    useEditorStore.getState().setToolState({
      type: 'select',
      dragStart: null,
      dragEnd: null,
    });
  };

  return {
    cursor: 'default',
    onMouseDown(worldPos: Point, screenPos: Point, ctx: ToolContext) {
      // Pick-center mode for circular copy
      const editorState = useEditorStore.getState();
      if (editorState.circularCopyPickingCenter && editorState.circularCopyEntityIds) {
        editorState.setCircularCopyCenter(worldPos);
        return;
      }

      // Pick-line mode for mirror
      if (editorState.mirrorPickingLine && editorState.mirrorEntityIds) {
        const activeSketch = useDocumentStore.getState().getActiveSketch();
        if (activeSketch) {
          const hit = hitTestEntities(screenPos, activeSketch.entities, ctx.viewport, activeSketch.entities);
          if (hit && hit.type === 'line' && hit.points.length >= 2) {
            const lineA = hit.points[0]!;
            const lineB = hit.points[hit.points.length - 1]!;
            useDocumentStore.getState().beginTransaction('Mirror');
            const newIds = useDocumentStore.getState().mirrorEntities(
              editorState.mirrorEntityIds,
              lineA,
              lineB,
            );
            editorState.setMirrorEntityIds(null);
            editorState.setMirrorPickingLine(false);
            if (newIds.length > 0) {
              editorState.setSelectedEntityIds(new Set(newIds));
            }
            requestSave();
            return;
          }
        }
        return;
      }

      mouseDownScreen = screenPos;
      dragStartWorld = worldPos;
      lastMoveWorld = worldPos;
      dragMode = null;
      shiftOnDown = !!ctx.shiftKey;

      const activeSketch = useDocumentStore.getState().getActiveSketch();
      if (activeSketch) {
        hitPointOnDown = hitTestPoint(screenPos, activeSketch.entities, ctx.viewport);
        hitEntityOnDown = hitPointOnDown
          ? null
          : hitTestEntities(screenPos, activeSketch.entities, ctx.viewport, activeSketch.entities);
      } else {
        hitPointOnDown = null;
        hitEntityOnDown = null;
      }
    },

    onMouseMove(worldPos: Point, screenPos: Point, _ctx: ToolContext) {
      if (!mouseDownScreen) return;

      // Decide drag mode at threshold
      if (dragMode === null && distance(screenPos, mouseDownScreen) > DRAG_THRESHOLD) {
        // Reset cycling state on drag
        cycleScreenPos = null;
        cycleCandidates = [];
        cycleIndex = -1;

        if (hitPointOnDown) {
          dragMode = 'move-point';
          useDocumentStore.getState().beginTransaction('Move point');
        } else if (hitEntityOnDown) {
          dragMode = 'move';
          useDocumentStore.getState().beginTransaction('Move entities');
          const selectedIds = useEditorStore.getState().selectedEntityIds;
          if (!selectedIds.has(hitEntityOnDown.id)) {
            useEditorStore.getState().setSelectedEntityIds(new Set([hitEntityOnDown.id]));
          }
        } else {
          dragMode = 'box-select';
        }
      }

      if (dragMode === 'move-point' && lastMoveWorld && hitPointOnDown) {
        const activeSketch = useDocumentStore.getState().getActiveSketch();
        // Skip if entity has a fixed constraint
        if (activeSketch?.constraints.some((c) => c.type === 'fixed' && c.entityId === hitPointOnDown!.entityId)) {
          lastMoveWorld = worldPos;
          return;
        }
        const entity = activeSketch?.entities.find((e) => e.id === hitPointOnDown!.entityId);
        if (entity && entity.type === 'line' && (entity as LineEntity).polygonCenter) {
          const center = (entity as LineEntity).polygonCenter!;
          const prevAngle = Math.atan2(lastMoveWorld.y - center.y, lastMoveWorld.x - center.x);
          const currAngle = Math.atan2(worldPos.y - center.y, worldPos.x - center.x);
          const angleDelta = currAngle - prevAngle;
          useDocumentStore.getState().rotatePolygon(hitPointOnDown.entityId, angleDelta);
        } else {
          const delta = { x: worldPos.x - lastMoveWorld.x, y: worldPos.y - lastMoveWorld.y };
          useDocumentStore.getState().movePoint(hitPointOnDown.entityId, hitPointOnDown.pointIndex, delta);
        }
        lastMoveWorld = worldPos;
      }

      if (dragMode === 'move' && lastMoveWorld) {
        const delta = { x: worldPos.x - lastMoveWorld.x, y: worldPos.y - lastMoveWorld.y };
        const selectedIds = useEditorStore.getState().selectedEntityIds;
        if (selectedIds.size > 0) {
          // Filter out fixed entities
          const activeSketchForMove = useDocumentStore.getState().getActiveSketch();
          const fixedIds = new Set(
            activeSketchForMove?.constraints
              .filter((c) => c.type === 'fixed')
              .map((c) => c.entityId) ?? [],
          );
          const movableIds = [...selectedIds].filter((id) => !fixedIds.has(id));
          if (movableIds.length > 0) {
            useDocumentStore.getState().moveEntities(movableIds, delta);
          }
        }
        lastMoveWorld = worldPos;
      }

      if (dragMode === 'box-select') {
        dragEndWorld = worldPos;
        useEditorStore.getState().setToolState({
          type: 'select',
          dragStart: dragStartWorld,
          dragEnd: dragEndWorld,
        });
      }
    },

    onMouseUp(worldPos: Point, screenPos: Point, ctx: ToolContext) {
      if (dragMode === 'box-select' && dragStartWorld) {
        // Box select
        const minX = Math.min(dragStartWorld.x, worldPos.x);
        const minY = Math.min(dragStartWorld.y, worldPos.y);
        const maxX = Math.max(dragStartWorld.x, worldPos.x);
        const maxY = Math.max(dragStartWorld.y, worldPos.y);

        const activeSketch = useDocumentStore.getState().getActiveSketch();
        if (activeSketch) {
          const ids = new Set<string>();
          for (const entity of activeSketch.entities) {
            if (entity.type === 'line') {
              const segCount = getSegmentCount(entity);
              for (let i = 0; i < segCount; i++) {
                const [i1, i2] = getSegmentPointIndices(entity, i);
                if (
                  segmentIntersectsRect(
                    entity.points[i1]!,
                    entity.points[i2]!,
                    { x: minX, y: minY },
                    { x: maxX, y: maxY },
                  )
                ) {
                  ids.add(entity.id);
                  break;
                }
              }
            }
            if (entity.type === 'circle') {
              if (circleIntersectsRect(entity.center, entity.radius, { x: minX, y: minY }, { x: maxX, y: maxY })) {
                ids.add(entity.id);
              }
            }
            if (entity.type === 'rectangle') {
              const hw = entity.width / 2;
              const hh = entity.height / 2;
              if (rectIntersectsRect(
                { x: entity.center.x - hw, y: entity.center.y - hh },
                { x: entity.center.x + hw, y: entity.center.y + hh },
                { x: minX, y: minY },
                { x: maxX, y: maxY },
              )) {
                ids.add(entity.id);
              }
            }
            if (entity.type === 'point') {
              const px = entity.position.x;
              const py = entity.position.y;
              if (px >= minX && px <= maxX && py >= minY && py <= maxY) {
                ids.add(entity.id);
              }
            }
          }
          useEditorStore.getState().setSelectedSegments([]);
          useEditorStore.getState().setSelectedEntityIds(ids);
          addLog('info', `Selected ${ids.size} entities`);
        }
      } else if (dragMode === null) {
        // Double-click detection
        const now = Date.now();
        const isDoubleClick =
          now - lastClickTime < 400 &&
          distance(screenPos, lastClickScreenPos) < 4;
        lastClickTime = now;
        lastClickScreenPos = screenPos;

        if (isDoubleClick) {
          cycleScreenPos = null;
          cycleCandidates = [];
          cycleIndex = -1;
          const activeSketch = useDocumentStore.getState().getActiveSketch();
          if (activeSketch) {
            const hit = hitTestEntities(screenPos, activeSketch.entities, ctx.viewport, activeSketch.entities);
            if (hit) {
              if (hit.type === 'dimension') {
                useEditorStore.getState().setEditingDimensionId(hit.id);
              } else {
                useEditorStore.getState().setSelectedPoints([]);
                useEditorStore.getState().setSelectedSegments([]);
                useEditorStore.getState().setSelectedEntityIds(new Set([hit.id]));
              }
              resetDrag();
              return;
            }
          }
        }

        // Click select (no drag occurred)
        const activeSketch = useDocumentStore.getState().getActiveSketch();
        if (activeSketch) {
          const entities = activeSketch.entities;

          if (shiftOnDown) {
            // Shift-click toggle logic (unchanged behavior, with logging)
            const pointHit = hitTestPoint(screenPos, entities, ctx.viewport);
            if (pointHit) {
              const sp: SelectedPoint = { entityId: pointHit.entityId, pointIndex: pointHit.pointIndex };
              useEditorStore.getState().toggleSelectedPoint(sp);
              addLog('info', `Toggle point ${pointHit.pointIndex} on ${pointHit.entityId.slice(0, 6)}`);
            } else {
              const segHit = hitTestSegment(screenPos, entities, ctx.viewport);
              if (segHit) {
                useEditorStore.getState().toggleSelectedSegment(segHit);
                useEditorStore.getState().addToSelection([segHit.entityId]);
                addLog('info', `Toggle segment ${segHit.segmentIndex} on ${segHit.entityId.slice(0, 6)}`);
              } else {
                const hit = hitTestEntities(screenPos, entities, ctx.viewport, entities);
                if (hit) {
                  const current = new Set(useEditorStore.getState().selectedEntityIds);
                  if (current.has(hit.id)) {
                    current.delete(hit.id);
                  } else {
                    current.add(hit.id);
                  }
                  useEditorStore.getState().setSelectedEntityIds(current);
                  addLog('info', `Toggle entity ${hit.type}_${hit.id.slice(0, 6)}`);
                }
              }
            }
          } else {
            // Non-shift click: cycling selection
            const isSamePos = cycleScreenPos && distance(screenPos, cycleScreenPos) < DRAG_THRESHOLD;

            if (isSamePos) {
              const fresh = hitTestAllCandidates(screenPos, entities, ctx.viewport, entities);
              if (candidatesMatch(fresh, cycleCandidates)) {
                cycleIndex = (cycleIndex + 1) % cycleCandidates.length;
              } else {
                cycleCandidates = fresh;
                cycleIndex = 0;
              }
            } else {
              cycleCandidates = hitTestAllCandidates(screenPos, entities, ctx.viewport, entities);
              cycleIndex = 0;
              cycleScreenPos = screenPos;
            }

            if (cycleCandidates.length === 0) {
              useEditorStore.getState().clearSelection();
              addLog('info', 'Deselected');
            } else {
              applyCandidate(cycleCandidates[cycleIndex]!);
              logCandidate(cycleCandidates[cycleIndex]!, cycleIndex, cycleCandidates.length);
            }
          }
        }
      }
      // dragMode === 'move' or 'move-point' → positions already applied incrementally, save
      if (dragMode === 'move' || dragMode === 'move-point') {
        requestSave();
      }
      resetDrag();
    },

    onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        const es = useEditorStore.getState();
        if (es.gridCopyEntityIds) {
          es.setGridCopyEntityIds(null);
          return;
        }
        if (es.circularCopyPickingCenter || es.circularCopyEntityIds) {
          es.setCircularCopyEntityIds(null);
          return;
        }
        if (es.mirrorPickingLine || es.mirrorEntityIds) {
          es.setMirrorEntityIds(null);
          es.setMirrorPickingLine(false);
          return;
        }
        es.clearSelection();
        resetDrag();
      }
      if (e.key === 'a' || e.key === 'A') {
        const ids = useEditorStore.getState().selectedEntityIds;
        if (ids.size > 0) {
          useEditorStore.getState().setCircularCopyEntityIds([...ids]);
        }
      }
      if (e.key === 'g' || e.key === 'G') {
        const ids = useEditorStore.getState().selectedEntityIds;
        if (ids.size > 0) {
          useEditorStore.getState().setGridCopyEntityIds([...ids]);
        }
      }
      if (e.key === 'm' || e.key === 'M') {
        const ids = useEditorStore.getState().selectedEntityIds;
        if (ids.size > 0) {
          useEditorStore.getState().setMirrorEntityIds([...ids]);
        }
      }
      if (e.key === 'k' || e.key === 'K') {
        const ids = useEditorStore.getState().selectedEntityIds;
        if (ids.size > 0) {
          useDocumentStore.getState().beginTransaction('Toggle fixed');
          useDocumentStore.getState().toggleFixed([...ids]);
          requestSave();
        }
      }
      if (e.key === '=') {
        const es = useEditorStore.getState();
        const selSegs = es.selectedSegments;
        if (selSegs.length === 2) {
          useDocumentStore.getState().beginTransaction('Toggle equal');
          useDocumentStore.getState().toggleEqual(
            [selSegs[0]!.entityId, selSegs[1]!.entityId],
            [selSegs[0]!, selSegs[1]!],
          );
          requestSave();
        } else {
          const ids = es.selectedEntityIds;
          if (ids.size === 2) {
            useDocumentStore.getState().beginTransaction('Toggle equal');
            useDocumentStore.getState().toggleEqual([...ids]);
            requestSave();
          }
        }
      }
      if (e.key === 'j' || e.key === 'J') {
        const es = useEditorStore.getState();
        const selPts = es.selectedPoints;
        const ids = es.selectedEntityIds;

        if (selPts.length === 2) {
          // Case 1: two selected points → coincident with explicit indices
          useDocumentStore.getState().beginTransaction('Toggle coincident');
          useDocumentStore.getState().toggleCoincidentWithPoints(selPts[0]!, selPts[1]!);
          requestSave();
        } else if (selPts.length === 1 && ids.size === 1) {
          // Case 2: one selected point + one selected entity → auto-nearest on entity
          const entityId = [...ids][0]!;
          const activeSketch = useDocumentStore.getState().getActiveSketch();
          if (activeSketch) {
            const entity = activeSketch.entities.find((ent) => ent.id === entityId);
            const sourceEntity = activeSketch.entities.find((ent) => ent.id === selPts[0]!.entityId);
            if (entity && sourceEntity) {
              const srcPt = getEntityPoint(sourceEntity, selPts[0]!.pointIndex);
              if (srcPt) {
                const pts = getEntityPoints(entity);
                let bestDist = Infinity;
                let bestIdx = 0;
                for (const [idx, p] of pts) {
                  const d = (p.x - srcPt.x) ** 2 + (p.y - srcPt.y) ** 2;
                  if (d < bestDist) {
                    bestDist = d;
                    bestIdx = idx;
                  }
                }
                useDocumentStore.getState().beginTransaction('Toggle coincident');
                useDocumentStore.getState().toggleCoincidentWithPoints(
                  selPts[0]!,
                  { entityId, pointIndex: bestIdx },
                );
                requestSave();
              }
            }
          }
        } else if (ids.size === 2) {
          // Case 3: two selected entities → existing auto-closest-pair
          useDocumentStore.getState().beginTransaction('Toggle coincident');
          useDocumentStore.getState().toggleCoincident([...ids]);
          requestSave();
        }
      }
      if (e.key === 'h' || e.key === 'H') {
        const es = useEditorStore.getState();
        const ids = es.selectedEntityIds;
        if (ids.size > 0) {
          const segs = es.selectedSegments.length > 0
            ? es.selectedSegments.map((s) => ({ entityId: s.entityId, segmentIndex: s.segmentIndex }))
            : undefined;
          useDocumentStore.getState().beginTransaction('Toggle horizontal');
          useDocumentStore.getState().toggleHorizontal([...ids], segs);
          requestSave();
        }
      }
      if (e.key === 'v') {
        const es = useEditorStore.getState();
        const ids = es.selectedEntityIds;
        if (ids.size > 0) {
          const segs = es.selectedSegments.length > 0
            ? es.selectedSegments.map((s) => ({ entityId: s.entityId, segmentIndex: s.segmentIndex }))
            : undefined;
          useDocumentStore.getState().beginTransaction('Toggle vertical');
          useDocumentStore.getState().toggleVertical([...ids], segs);
          requestSave();
        }
      }
      if (e.key === 'n' || e.key === 'N') {
        const segs = resolveTwoSegments();
        if (segs) {
          useDocumentStore.getState().beginTransaction('Toggle parallel');
          useDocumentStore.getState().toggleParallel(segs[0]!, segs[1]!);
          requestSave();
        }
      }
      if (e.key === 't' || e.key === 'T') {
        const segs = resolveTwoSegments();
        if (segs) {
          useDocumentStore.getState().beginTransaction('Toggle perpendicular');
          useDocumentStore.getState().togglePerpendicular(segs[0]!, segs[1]!);
          requestSave();
        }
      }
      if (e.key === 'b' || e.key === 'B') {
        const segs = resolveTwoSegments();
        if (segs) {
          useDocumentStore.getState().beginTransaction('Toggle bisect');
          useDocumentStore.getState().toggleBisect(segs[0]!, segs[1]!);
          requestSave();
        }
      }
      if (e.key === 'i' || e.key === 'I') {
        const es = useEditorStore.getState();
        const selPts = es.selectedPoints;
        const selSegs = es.selectedSegments;
        if (selPts.length === 1 && selSegs.length === 1) {
          useDocumentStore.getState().beginTransaction('Toggle midpoint');
          useDocumentStore.getState().toggleMidpoint(selPts[0]!, selSegs[0]!);
          requestSave();
        }
      }
      if (e.key === 'y' || e.key === 'Y') {
        const es = useEditorStore.getState();
        const selSegs = es.selectedSegments;
        const ids = es.selectedEntityIds;
        const activeSketch = useDocumentStore.getState().getActiveSketch();
        if (activeSketch) {
          if (selSegs.length === 1 && ids.size === 2) {
            // Line-circle: one segment selected, two entities, the non-segment entity is a circle
            const segEntityId = selSegs[0]!.entityId;
            const otherIds = [...ids].filter((id) => id !== segEntityId);
            if (otherIds.length === 1) {
              const otherEntity = activeSketch.entities.find((ent) => ent.id === otherIds[0]!);
              if (otherEntity && otherEntity.type === 'circle') {
                useDocumentStore.getState().beginTransaction('Toggle tangent');
                useDocumentStore.getState().toggleTangent(segEntityId, selSegs[0]!.segmentIndex, otherIds[0]!, -1);
                requestSave();
              }
            }
          } else if (ids.size === 2 && selSegs.length === 0) {
            // Circle-circle: two entities selected, no segments, both circles
            const idArr = [...ids];
            const e1 = activeSketch.entities.find((ent) => ent.id === idArr[0]!);
            const e2 = activeSketch.entities.find((ent) => ent.id === idArr[1]!);
            if (e1 && e2 && e1.type === 'circle' && e2.type === 'circle') {
              useDocumentStore.getState().beginTransaction('Toggle tangent');
              useDocumentStore.getState().toggleTangent(idArr[0]!, -1, idArr[1]!, -1);
              requestSave();
            }
          }
        }
      }
      if (e.key === 'w' || e.key === 'W') {
        const ids = useEditorStore.getState().selectedEntityIds;
        if (ids.size > 0) {
          useDocumentStore.getState().beginTransaction('Toggle closed');
          useDocumentStore.getState().toggleClosed([...ids]);
          requestSave();
        }
      }
      if (e.key === 'x' || e.key === 'X') {
        const ids = useEditorStore.getState().selectedEntityIds;
        if (ids.size > 0) {
          useDocumentStore.getState().beginTransaction('Toggle construction');
          useDocumentStore.getState().toggleConstruction([...ids]);
          requestSave();
        }
      }
      if (e.key === 'Q' && e.shiftKey) {
        const doc = useDocumentStore.getState().document;
        const json = JSON.stringify(doc, null, 2);
        navigator.clipboard.writeText(json);
        addLog('info', 'Copied document to clipboard');
      } else if (e.key === 'q') {
        const ids = useEditorStore.getState().selectedEntityIds;
        if (ids.size > 0) {
          const activeSketch = useDocumentStore.getState().getActiveSketch();
          if (activeSketch) {
            const selected = activeSketch.entities.filter((ent) => ids.has(ent.id));
            const json = JSON.stringify(selected, null, 2);
            navigator.clipboard.writeText(json);
            addLog('info', `Copied ${selected.length} entities to clipboard`);
          }
        }
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        const ids = useEditorStore.getState().selectedEntityIds;
        if (ids.size > 0) {
          useDocumentStore.getState().beginTransaction('Delete entities');
          useDocumentStore.getState().removeEntities([...ids]);
          useEditorStore.getState().clearSelection();
          requestSave();
        }
      }
    },

    renderOverlay(renderer: Renderer, viewport: Viewport) {
      const ts = useEditorStore.getState().toolState;
      if (ts.type !== 'select' || !ts.dragStart || !ts.dragEnd) return;

      const a = viewport.worldToScreen(ts.dragStart);
      const b = viewport.worldToScreen(ts.dragEnd);

      const topLeft = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) };
      const size = {
        x: Math.abs(b.x - a.x),
        y: Math.abs(b.y - a.y),
      };

      const palette = getThemePalette();
      renderer.drawRect(topLeft, size, palette.selectionRect, {
        color: palette.selectionRectBorder,
        width: 1,
      });
    },
  };
}
