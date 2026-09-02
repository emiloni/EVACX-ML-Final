"use client";

import {
  useState, useRef, useCallback, useEffect,
} from "react";

/* ============================================================
   Types
   ============================================================ */

interface Point { x: number; y: number; }

interface FloorElement {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number;
  wheelchair_accessible?: boolean;
  estimated?: boolean;
  source?: string;
  original_confidence?: number;
}

interface FloorPlanData {
  width: number;
  height: number;
  units: string;
  approximate: boolean;
  confidence: number;
  elements: FloorElement[];
}

interface EditOperation {
  type: "move" | "add" | "delete" | "resize";
  elementId: string;
  before: Partial<FloorElement> | null;
  after: Partial<FloorElement> | null;
}

/* ---- Simulation overlay types ---- */

export interface RouteOverlay {
  occupantId: string;
  points: Array<{ x: number; y: number }>;
  color: string;
  isSelected: boolean;
}

export interface OccupantOverlay {
  id: string;
  x: number;
  y: number;
  mobility: string;
  name: string;
  status: "waiting" | "evacuating" | "evacuated" | "blocked" | "no_route";
}

/* ---- Congestion overlay ---- */
export interface CongestionOverlay {
  zoneId: string;
  zoneName: string;
  status: string; // NORMAL | HIGH_OCCUPANCY | CONGESTED | BOTTLENECK
  people: number;
  capacity: number;
  percentage: number;
}

/* ---- Exit status overlay ---- */
export interface ExitStatusOverlay {
  exitId: string;
  exitName: string;
  availability: string; // RECOMMENDED | AVAILABLE | AVOID | BLOCKED
  reason: string;
  congestionStatus: string;
}

interface FloorPlanViewerProps {
  floorPlan: FloorPlanData;
  onChange?: (plan: FloorPlanData) => void;
  onSave?: (plan: FloorPlanData) => void;
  className?: string;
  /** When set, the fire room gets a hazard overlay */
  fireRoomId?: string;
  /** Evacuation routes to draw on the floor plan */
  routes?: RouteOverlay[];
  /** Occupant markers to display */
  occupants?: OccupantOverlay[];
  /** When true, editing tools are locked */
  simulationMode?: boolean;
  /** Zones with congestion to highlight on the floor plan */
  congestionOverlays?: CongestionOverlay[];
  /** Exit availability status overlays */
  exitStatuses?: ExitStatusOverlay[];
}

/* ============================================================
   Constants
   ============================================================ */

const GRID_SIZE = 20;
const SNAP_THRESHOLD = 15;
const HISTORY_LIMIT = 50;

const COLORS: Record<string, { fill: string; stroke: string; text: string }> = {
  corridor: { fill: "#f1f5f9", stroke: "#94a3b8", text: "#475569" },
  door:     { fill: "#f0fdfa", stroke: "#14b8a6", text: "#0d9488" },
  room:     { fill: "#ffffff", stroke: "#e2e8f0", text: "#475569" },
  stairs:   { fill: "#fef9c3", stroke: "#eab308", text: "#a16207" },
  ramp:     { fill: "#ccfbf1", stroke: "#10b981", text: "#065f46" },
  elevator: { fill: "#ccfbf1", stroke: "#10b981", text: "#065f46" },
  exit:     { fill: "#fee2e2", stroke: "#ef4444", text: "#991b1b" },
};

const LABELS: Record<string, string> = {
  corridor: "CORRIDOR", door: "DOOR", room: "ROOM",
  stairs: "STAIRS", ramp: "RAMP", elevator: "ELEVATOR", exit: "EXIT",
};

const ADDABLE_TYPES = ["door", "exit", "stairs", "elevator", "ramp", "room"];

/* ============================================================
   Component
   ============================================================ */

export default function FloorPlanViewer({
  floorPlan,
  onChange,
  onSave,
  className = "",
  fireRoomId,
  routes = [],
  occupants = [],
  simulationMode = false,
  congestionOverlays = [],
  exitStatuses = [],
}: FloorPlanViewerProps) {
  // --- View state ---
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });

  // --- Mode ---
  const [editMode, setEditMode] = useState(false);
  const [showGrid, setShowGrid] = useState(false);
  const [snapToGrid, setSnapToGrid] = useState(false);

  // --- Selection ---
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // --- Drag state ---
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{
    elementId: string | null;
    startX: number; startY: number;
    origX: number; origY: number;
    isPan: boolean;
  }>({ elementId: null, startX: 0, startY: 0, origX: 0, origY: 0, isPan: false });

  // --- Add mode ---
  const [addType, setAddType] = useState<string | null>(null);

  // --- History ---
  const [history, setHistory] = useState<EditOperation[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);

  // --- Local draft ---
  const [draft, setDraft] = useState<FloorPlanData>(floorPlan);
  const [unsaved, setUnsaved] = useState(false);
  const userEditRef = useRef(false); // tracks whether draft was changed by user edits vs prop sync

  // --- Validation ---
  const [validationIssues, setValidationIssues] = useState<string[]>([]);

  const containerRef = useRef<HTMLDivElement>(null);

  // Sync draft when floorPlan prop changes
  useEffect(() => {
    userEditRef.current = false; // suppress onChange during prop sync
    setDraft(floorPlan);
    setHistory([]);
    setHistoryIndex(-1);
    setUnsaved(false);
    setSelectedId(null);
    setValidationIssues([]);
  }, [floorPlan]);

  // Notify parent when the user edits the draft (drag, add, delete, undo, redo)
  useEffect(() => {
    if (userEditRef.current && onChange) {
      onChange(draft);
    }
    userEditRef.current = false;
  }, [draft, onChange]);

  // Lock editing when simulation mode is active
  const effectiveEditMode = simulationMode ? false : editMode;

  // --- Coordinate transforms ---
  const screenToWorld = useCallback(
    (sx: number, sy: number) => {
      const pad = 40;
      return {
        x: (sx - pad - pan.x) / zoom,
        y: (sy - pad - pan.y) / zoom,
      };
    },
    [zoom, pan]
  );

  const snapToGridFn = useCallback(
    (val: number) => snapToGrid ? Math.round(val / GRID_SIZE) * GRID_SIZE : val,
    [snapToGrid]
  );

  // --- History management ---
  const pushHistory = useCallback((op: EditOperation) => {
    setHistory((prev) => {
      const trimmed = prev.slice(0, historyIndex + 1);
      const next = [...trimmed, op];
      if (next.length > HISTORY_LIMIT) next.shift();
      return next;
    });
    setHistoryIndex((prev) => Math.min(prev + 1, HISTORY_LIMIT - 1));
    setUnsaved(true);
  }, [historyIndex]);

  const undo = useCallback(() => {
    if (historyIndex < 0) return;
    const op = history[historyIndex];
    userEditRef.current = true;
    setDraft((prev) => {
      const elements = [...prev.elements];
      if (op.type === "delete" && op.before) {
        elements.push(op.before as FloorElement);
      } else if (op.type === "add") {
        const idx = elements.findIndex((e) => e.id === op.elementId);
        if (idx >= 0) elements.splice(idx, 1);
      } else if (op.before) {
        const idx = elements.findIndex((e) => e.id === op.elementId);
        if (idx >= 0) elements[idx] = { ...elements[idx], ...op.before };
      }
      return { ...prev, elements };
    });
    setHistoryIndex((prev) => prev - 1);
    setUnsaved(true);
  }, [history, historyIndex]);

  const redo = useCallback(() => {
    if (historyIndex >= history.length - 1) return;
    const op = history[historyIndex + 1];
    userEditRef.current = true;
    setDraft((prev) => {
      const elements = [...prev.elements];
      if (op.type === "add" && op.after) {
        elements.push(op.after as FloorElement);
      } else if (op.type === "delete") {
        const idx = elements.findIndex((e) => e.id === op.elementId);
        if (idx >= 0) elements.splice(idx, 1);
      } else if (op.after) {
        const idx = elements.findIndex((e) => e.id === op.elementId);
        if (idx >= 0) elements[idx] = { ...elements[idx], ...op.after };
      }
      return { ...prev, elements };
    });
    setHistoryIndex((prev) => prev + 1);
    setUnsaved(true);
  }, [history, historyIndex]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!effectiveEditMode) return;
      if ((e.ctrlKey || e.metaKey) && e.key === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
      if ((e.ctrlKey || e.metaKey) && e.key === "z" && e.shiftKey) { e.preventDefault(); redo(); }
      if ((e.ctrlKey || e.metaKey) && e.key === "y") { e.preventDefault(); redo(); }
      if (e.key === "Delete" || e.key === "Backspace") {
        if (selectedId) deleteElement(selectedId);
      }
      if (e.key === "Escape") {
        setSelectedId(null);
        setAddType(null);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [effectiveEditMode, selectedId, undo, redo]);

  // --- Element operations ---
  const updateElement = useCallback((id: string, changes: Partial<FloorElement>) => {
    userEditRef.current = true;
    setDraft((prev) => ({
      ...prev,
      elements: prev.elements.map((e) => e.id === id ? { ...e, ...changes } : e),
    }));
    setUnsaved(true);
  }, []);

  const deleteElement = useCallback((id: string) => {
    const el = draft.elements.find((e) => e.id === id);
    if (!el) return;
    pushHistory({ type: "delete", elementId: id, before: el, after: null });
    userEditRef.current = true;
    setDraft((prev) => ({
      ...prev,
      elements: prev.elements.filter((e) => e.id !== id),
    }));
    setSelectedId(null);
    setUnsaved(true);
  }, [draft, pushHistory]);

  const addElement = useCallback((type: string, x: number, y: number) => {
    const id = `user_${type}_${Date.now()}`;
    const sizes: Record<string, { w: number; h: number }> = {
      door: { w: 50, h: 10 }, exit: { w: 55, h: 55 },
      stairs: { w: 100, h: 80 }, elevator: { w: 80, h: 80 },
      ramp: { w: 80, h: 80 }, room: { w: 160, h: 130 },
    };
    const s = sizes[type] || { w: 50, h: 50 };
    const newEl: FloorElement = {
      id, type, x: snapToGridFn(x - s.w / 2), y: snapToGridFn(y - s.h / 2),
      width: s.w, height: s.h, confidence: 1.0,
      source: "user_added",
    };
    pushHistory({ type: "add", elementId: id, before: null, after: newEl });
    userEditRef.current = true;
    setDraft((prev) => ({ ...prev, elements: [...prev.elements, newEl] }));
    setAddType(null);
    setSelectedId(id);
    setUnsaved(true);
  }, [pushHistory, snapToGridFn]);

  // --- Validation ---
  const validate = useCallback(() => {
    const issues: string[] = [];
    const elements = draft.elements;
    if (!elements.some((e) => e.type === "corridor")) issues.push("No corridor element");
    if (!elements.some((e) => e.type === "exit")) issues.push("No exit element");
    const rooms = elements.filter((e) => e.type === "room");
    for (let i = 0; i < rooms.length; i++) {
      for (let j = i + 1; j < rooms.length; j++) {
        const a = rooms[i], b = rooms[j];
        const ox = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
        const oy = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
        if (ox > 0 && oy > 0) issues.push(`Room overlap: ${a.id} and ${b.id}`);
      }
    }
    const corridors = elements.filter((e) => e.type === "corridor");
    const exits = elements.filter((e) => e.type === "exit");
    for (const ex of exits) {
      const near = corridors.some((c) => {
        const dx = Math.max(0, Math.abs(ex.x + ex.width / 2 - (c.x + c.width / 2)) - ex.width / 2 - c.width / 2);
        const dy = Math.max(0, Math.abs(ex.y + ex.height / 2 - (c.y + c.height / 2)) - ex.height / 2 - c.height / 2);
        return dx + dy < SNAP_THRESHOLD * 5;
      });
      if (!near) issues.push(`Exit ${ex.id} is not connected to a corridor`);
    }
    setValidationIssues(issues);
    return issues;
  }, [draft]);

  // --- Save ---
  const handleSave = useCallback(() => {
    const issues = validate();
    if (issues.length > 0) return;
    const finalElements = draft.elements.map((e) => ({
      ...e,
      source: e.source === "user_added" ? "user_added" : "user_corrected",
      original_confidence: e.original_confidence ?? e.confidence,
    }));
    const finalPlan = { ...draft, elements: finalElements };
    setDraft(finalPlan);
    setUnsaved(false);
    onSave?.(finalPlan);
  }, [draft, validate, onSave]);

  // --- Mouse handlers ---
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (simulationMode) return;
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;

    if (addType && effectiveEditMode) {
      const world = screenToWorld(sx, sy);
      addElement(addType, world.x, world.y);
      return;
    }

    if (effectiveEditMode) {
      const world = screenToWorld(sx, sy);
      const clicked = [...draft.elements].reverse().find((el) => {
        return world.x >= el.x && world.x <= el.x + el.width &&
               world.y >= el.y && world.y <= el.y + el.height;
      });
      if (clicked) {
        setSelectedId(clicked.id);
        setDragging(true);
        dragRef.current = {
          elementId: clicked.id, startX: e.clientX, startY: e.clientY,
          origX: clicked.x, origY: clicked.y, isPan: false,
        };
        return;
      }
      setSelectedId(null);
    }

    setDragging(true);
    dragRef.current = {
      elementId: null, startX: e.clientX, startY: e.clientY,
      origX: pan.x, origY: pan.y, isPan: true,
    };
  }, [simulationMode, effectiveEditMode, addType, draft.elements, screenToWorld, pan, addElement]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!dragging) return;
    const dx = e.clientX - dragRef.current.startX;
    const dy = e.clientY - dragRef.current.startY;

    if (dragRef.current.isPan) {
      setPan({ x: dragRef.current.origX + dx, y: dragRef.current.origY + dy });
    } else if (dragRef.current.elementId) {
      const newX = snapToGridFn(dragRef.current.origX + dx / zoom);
      const newY = snapToGridFn(dragRef.current.origY + dy / zoom);
      updateElement(dragRef.current.elementId, { x: newX, y: newY });
    }
  }, [dragging, zoom, snapToGridFn, updateElement]);

  const handleMouseUp = useCallback(() => {
    if (dragging && dragRef.current.elementId) {
      const el = draft.elements.find((e) => e.id === dragRef.current.elementId);
      if (el) {
        pushHistory({
          type: "move", elementId: dragRef.current.elementId,
          before: { x: dragRef.current.origX, y: dragRef.current.origY },
          after: { x: el.x, y: el.y, source: "user_corrected" },
        });
      }
    }
    setDragging(false);
  }, [dragging, draft.elements, pushHistory]);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.1 : 0.1;
    setZoom((z) => Math.min(Math.max(z + delta, 0.2), 4));
  }, []);

  // --- Drawing ---
  const pad = 40;
  const drawOrder = ["corridor", "room", "door", "stairs", "ramp", "elevator", "exit"];
  const sorted = [...draft.elements].sort((a, b) => {
    const ai = drawOrder.indexOf(a.type);
    const bi = drawOrder.indexOf(b.type);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });

  // Helper: world coords → screen coords for SVG
  const wx = (vx: number) => pad + vx * zoom;
  const wy = (vy: number) => pad + vy * zoom;

  return (
    <div className={`rounded-xl border border-slate-200 bg-white overflow-hidden shadow-sm ${className}`}>
      {/* ── Toolbar ── */}
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-2 flex-wrap gap-2">
        <div className="flex items-center gap-3">
          <h3 className="text-sm font-semibold text-slate-800">2D Floor Plan</h3>
          {unsaved && <span className="text-[10px] text-amber-500">● Unsaved changes</span>}
          {simulationMode && <span className="text-[10px] text-teal-600 bg-teal-50 border border-teal-200 rounded px-1.5 py-0.5">Simulation Mode</span>}
        </div>

        <div className="flex items-center gap-1.5 flex-wrap">
          {!simulationMode && (
            <>
              <button
                onClick={() => { setEditMode(false); setSelectedId(null); setAddType(null); }}
                className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition ${
                  !editMode ? "bg-teal-50 text-teal-700 border border-teal-200" : "bg-slate-100 text-slate-500 hover:bg-slate-50 border border-transparent"
                }`}
              >View</button>
              <button
                onClick={() => setEditMode(true)}
                className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition ${
                  editMode ? "bg-teal-50 text-teal-700 border border-teal-200" : "bg-slate-100 text-slate-500 hover:bg-slate-50 border border-transparent"
                }`}
              >Edit</button>

              <div className="w-px h-4 bg-slate-200 mx-1" />

              <button onClick={undo} disabled={historyIndex < 0}
                className="rounded-md bg-slate-100 px-2 py-1 text-[11px] text-slate-600 hover:bg-slate-200 disabled:opacity-30"
                title="Undo (Ctrl+Z)">↩</button>
              <button onClick={redo} disabled={historyIndex >= history.length - 1}
                className="rounded-md bg-slate-100 px-2 py-1 text-[11px] text-slate-600 hover:bg-slate-200 disabled:opacity-30"
                title="Redo (Ctrl+Shift+Z)">↪</button>

              <div className="w-px h-4 bg-slate-200 mx-1" />

              {editMode && (
                <>
                  <button onClick={() => setShowGrid((g) => !g)}
                    className={`rounded-md px-2 py-1 text-[11px] ${showGrid ? "bg-teal-50 text-teal-700 border border-teal-200" : "bg-slate-100 text-slate-500 hover:bg-slate-50 border border-transparent"}`}>
                    Grid
                  </button>
                  <button onClick={() => setSnapToGrid((s) => !s)}
                    className={`rounded-md px-2 py-1 text-[11px] ${snapToGrid ? "bg-teal-50 text-teal-700 border border-teal-200" : "bg-slate-100 text-slate-500 hover:bg-slate-50 border border-transparent"}`}>
                    Snap
                  </button>
                  <div className="w-px h-4 bg-slate-200 mx-1" />
                </>
              )}

              <button onClick={validate}
                className="rounded-md bg-slate-100 px-2.5 py-1 text-[11px] text-slate-600 hover:bg-slate-200">Validate</button>
              <button onClick={handleSave} disabled={!unsaved || validationIssues.length > 0}
                className="rounded-md bg-teal-600 px-2.5 py-1 text-[11px] text-white hover:bg-teal-700 disabled:opacity-40">
                Save
              </button>
            </>
          )}

          <div className="w-px h-4 bg-slate-200 mx-1" />

          <button onClick={() => setZoom((z) => Math.min(z + 0.2, 4))}
            className="rounded-md bg-slate-100 px-2 py-1 text-[11px] text-slate-600 hover:bg-slate-200">+</button>
          <button onClick={() => setZoom((z) => Math.max(z - 0.2, 0.2))}
            className="rounded-md bg-slate-100 px-2 py-1 text-[11px] text-slate-600 hover:bg-slate-200">−</button>
          <button onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }}
            className="rounded-md bg-slate-100 px-2 py-1 text-[11px] text-slate-600 hover:bg-slate-200">Fit</button>
          <span className="text-[10px] text-slate-400 w-8 text-right">{Math.round(zoom * 100)}%</span>
        </div>
      </div>

      {/* ── Add toolbar (edit mode only) ── */}
      {effectiveEditMode && (
        <div className="flex items-center gap-1.5 border-b border-slate-100 px-4 py-1.5 bg-slate-50">
          <span className="text-[10px] text-slate-400 mr-1">Add:</span>
          {ADDABLE_TYPES.map((t) => (
            <button key={t} onClick={() => setAddType(addType === t ? null : t)}
              className={`rounded px-2 py-0.5 text-[10px] font-medium transition ${
                addType === t ? "bg-teal-50 text-teal-700 border border-teal-200" : "bg-slate-100 text-slate-500 hover:bg-slate-200 border border-transparent"
              }`}>
              + {LABELS[t] || t}
            </button>
          ))}
          {addType && (
            <span className="text-[10px] text-teal-600 ml-2">Click on floor plan to place {LABELS[addType]}</span>
          )}
        </div>
      )}

      {/* ── Canvas ── */}
      <div
        ref={containerRef}
        className={`relative min-h-[520px] overflow-hidden bg-slate-50 select-none ${
          simulationMode ? "cursor-default" : effectiveEditMode ? (addType ? "cursor-crosshair" : "cursor-default") : "cursor-grab active:cursor-grabbing"
        }`}
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      >
        <svg width="100%" height="100%" className="absolute inset-0"
          style={{ transform: `translate(${pan.x}px, ${pan.y}px)` }}>

          {/* Grid */}
          {showGrid && effectiveEditMode && (
            <defs>
              <pattern id="grid" width={GRID_SIZE * zoom} height={GRID_SIZE * zoom} patternUnits="userSpaceOnUse">
                <path d={`M ${GRID_SIZE * zoom} 0 L 0 0 0 ${GRID_SIZE * zoom}`}
                  fill="none" stroke="rgba(0,0,0,0.06)" strokeWidth="0.5" />
              </pattern>
            </defs>
          )}
          {showGrid && effectiveEditMode && (
            <rect width="100%" height="100%" fill="url(#grid)" style={{ transform: `translate(${pan.x}px, ${pan.y}px)` }} />
          )}

          {/* Layer 1-4: Floor plan elements */}
          {sorted.map((el) => {
            const c = COLORS[el.type] || { fill: "#f1f5f9", stroke: "#94a3b8", text: "#475569" };
            const isLow = el.confidence < 0.4;
            const isSel = selectedId === el.id;
            const isUserAdded = el.source === "user_added";
            const x = pad + el.x * zoom;
            const y = pad + el.y * zoom;
            const w = Math.max(el.width * zoom, 2);
            const h = Math.max(el.height * zoom, 2);

            // Fire room overlay
            const isFireRoom = fireRoomId === el.id;

            return (
              <g key={el.id}>
                <rect
                  x={x} y={y} width={w} height={h}
                  rx={el.type === "door" ? 1 : 3}
                  fill={isFireRoom ? "#fee2e2" : c.fill}
                  stroke={isFireRoom ? "#ef4444" : isSel ? "#0d9488" : isUserAdded ? "#0891b2" : c.stroke}
                  strokeWidth={isFireRoom ? 2.5 : isSel ? 2.5 : 1.5}
                  strokeDasharray={isLow && !isUserAdded ? "4,2" : undefined}
                  opacity={isLow && !isUserAdded ? 0.6 : 1}
                  style={{ cursor: effectiveEditMode ? "pointer" : "inherit" }}
                />
                {w > 35 && h > 14 && (
                  <text x={x + w / 2} y={y + h / 2 - (isFireRoom ? 6 : 0)} textAnchor="middle"
                    dominantBaseline="central" fill={isFireRoom ? "#991b1b" : c.text}
                    fontSize={Math.min(9, w / 6)} fontFamily="system-ui" fontWeight={600} opacity={0.9}>
                    {LABELS[el.type] || el.type}
                  </text>
                )}
                {/* Fire icon */}
                {isFireRoom && (
                  <text x={x + w / 2} y={y + h / 2 + 10} textAnchor="middle" dominantBaseline="central"
                    fontSize={Math.min(20, w / 3)} className="select-none pointer-events-none">
                    🔥
                  </text>
                )}
                {isLow && !isUserAdded && <text x={x + w - 6} y={y + 2} fontSize={8} fill="#eab308">⚠</text>}
                {isUserAdded && <text x={x + 2} y={y + 10} fontSize={7} fill="#0891b2">+</text>}
                {isSel && effectiveEditMode && (
                  <>
                    <rect x={x - 3} y={y - 3} width={6} height={6} fill="#0d9488" rx={1} />
                    <rect x={x + w - 3} y={y - 3} width={6} height={6} fill="#0d9488" rx={1} />
                    <rect x={x - 3} y={y + h - 3} width={6} height={6} fill="#0d9488" rx={1} />
                    <rect x={x + w - 3} y={y + h - 3} width={6} height={6} fill="#0d9488" rx={1} />
                  </>
                )}
              </g>
            );
          })}

          {/* Layer 5: Fire room glow (animated) */}
          {fireRoomId && (() => {
            const fireEl = draft.elements.find((e) => e.id === fireRoomId);
            if (!fireEl) return null;
            const x = pad + fireEl.x * zoom;
            const y = pad + fireEl.y * zoom;
            const w = Math.max(fireEl.width * zoom, 2);
            const h = Math.max(fireEl.height * zoom, 2);
            return (
              <rect
                x={x - 3} y={y - 3} width={w + 6} height={h + 6}
                rx={5} fill="none" stroke="#ef4444" strokeWidth={1.5}
                opacity={0.5}
                style={{ animation: "pulse-fire 2s ease-in-out infinite" }}
              />
            );
          })()}

          {/* Layer 5b: Congestion zone highlights */}
          {congestionOverlays.map((co) => {
            const el = draft.elements.find((e) => e.id === co.zoneId);
            if (!el) return null;
            const x = pad + el.x * zoom;
            const y = pad + el.y * zoom;
            const w = Math.max(el.width * zoom, 2);
            const h = Math.max(el.height * zoom, 2);
            const colors: Record<string, { fill: string; stroke: string; label: string }> = {
              BOTTLENECK: { fill: "rgba(239,68,68,0.15)", stroke: "#ef4444", label: "🔴" },
              CONGESTED: { fill: "rgba(249,115,22,0.12)", stroke: "#f97316", label: "🟠" },
              HIGH_OCCUPANCY: { fill: "rgba(245,158,11,0.10)", stroke: "#f59e0b", label: "🟡" },
            };
            const c = colors[co.status];
            if (!c) return null;
            return (
              <g key={`cong-${co.zoneId}`}>
                <rect
                  x={x - 2} y={y - 2} width={w + 4} height={h + 4}
                  rx={4} fill={c.fill} stroke={c.stroke} strokeWidth={2}
                  strokeDasharray="6,3"
                  style={{ animation: "pulse-congestion 2.5s ease-in-out infinite" }}
                />
                {/* Congestion label */}
                {w > 40 && (
                  <text x={x + w / 2} y={y - 6} textAnchor="middle"
                    fontSize={9} fontWeight={700} fill={c.stroke}
                    fontFamily="system-ui" className="select-none pointer-events-none">
                    {c.label} {co.status} ({co.people}/{co.capacity})
                  </text>
                )}
              </g>
            );
          })}

          {/* Layer 5c: Exit status indicators */}
          {exitStatuses.map((es) => {
            const el = draft.elements.find((e) => e.id === es.exitId);
            if (!el) return null;
            const x = pad + el.x * zoom;
            const y = pad + el.y * zoom;
            const w = Math.max(el.width * zoom, 2);
            const h = Math.max(el.height * zoom, 2);
            const statusColors: Record<string, { bg: string; border: string; icon: string; text: string }> = {
              RECOMMENDED: { bg: "rgba(16,185,129,0.20)", border: "#10b981", icon: "🟢", text: "RECOMMENDED" },
              AVAILABLE: { bg: "rgba(20,184,166,0.10)", border: "#14b8a6", icon: "✅", text: "AVAILABLE" },
              AVOID: { bg: "rgba(239,68,68,0.15)", border: "#ef4444", icon: "🔴", text: "AVOID" },
              BLOCKED: { bg: "rgba(107,114,128,0.20)", border: "#6b7280", icon: "🚫", text: "BLOCKED" },
            };
            const sc = statusColors[es.availability];
            if (!sc) return null;
            return (
              <g key={`exit-${es.exitId}`}>
                <rect
                  x={x - 2} y={y - 2} width={w + 4} height={h + 4}
                  rx={4} fill={sc.bg} stroke={sc.border} strokeWidth={2.5}
                />
                {/* Exit status label above */}
                <text x={x + w / 2} y={y - 8} textAnchor="middle"
                  fontSize={9} fontWeight={700} fill={sc.border}
                  fontFamily="system-ui" className="select-none pointer-events-none">
                  {sc.icon} {sc.text}
                </text>
                {/* Reason below */}
                <text x={x + w / 2} y={y + h + 12} textAnchor="middle"
                  fontSize={7} fill={sc.border} opacity={0.8}
                  fontFamily="system-ui" className="select-none pointer-events-none">
                  {es.reason.length > 30 ? es.reason.substring(0, 30) + "..." : es.reason}
                </text>
              </g>
            );
          })}

          {/* Layer 6: Evacuation routes */}
          {routes.map((route) => {
            if (route.points.length < 2) return null;
            const pathD = route.points
              .map((p, i) => `${i === 0 ? "M" : "L"} ${wx(p.x)} ${wy(p.y)}`)
              .join(" ");
            return (
              <g key={route.occupantId}>
                {/* Route shadow */}
                <path
                  d={pathD}
                  fill="none"
                  stroke={route.color}
                  strokeWidth={route.isSelected ? 5 : 3}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  opacity={route.isSelected ? 0.25 : 0.12}
                />
                {/* Route line */}
                <path
                  d={pathD}
                  fill="none"
                  stroke={route.color}
                  strokeWidth={route.isSelected ? 3 : 2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeDasharray={route.isSelected ? "none" : "8,4"}
                  opacity={route.isSelected ? 1 : 0.7}
                />
              </g>
            );
          })}

          {/* Layer 7: Occupant markers */}
          {occupants.map((occ) => {
            const sx = wx(occ.x);
            const sy = wy(occ.y);
            const isEvacuated = occ.status === "evacuated";
            const isBlocked = occ.status === "blocked" || occ.status === "no_route";
            const isWheelchair = occ.mobility === "wheelchair";

            let markerColor = "#0d9488"; // teal for normal
            if (isEvacuated) markerColor = "#10b981"; // green
            if (isBlocked) markerColor = "#ef4444"; // red
            if (occ.status === "evacuating") markerColor = "#0891b2"; // cyan

            return (
              <g key={occ.id}>
                {/* Marker circle */}
                <circle
                  cx={sx} cy={sy} r={isWheelchair ? 10 : 7}
                  fill={markerColor}
                  stroke="white"
                  strokeWidth={2}
                  opacity={isEvacuated ? 0.5 : 1}
                />
                {/* Mobility icon inside */}
                {isWheelchair && (
                  <text x={sx} y={sy} textAnchor="middle" dominantBaseline="central"
                    fontSize={10} fill="white" fontWeight="bold">♿</text>
                )}
                {!isWheelchair && !isBlocked && (
                  <text x={sx} y={sy + 1} textAnchor="middle" dominantBaseline="central"
                    fontSize={8} fill="white" fontWeight="bold">
                    {occ.status === "evacuated" ? "✓" : occ.status === "evacuating" ? "→" : "●"}
                  </text>
                )}
                {isBlocked && (
                  <text x={sx} y={sy + 1} textAnchor="middle" dominantBaseline="central"
                    fontSize={8} fill="white" fontWeight="bold">✕</text>
                )}
                {/* Name label */}
                <text
                  x={sx} y={sy - (isWheelchair ? 14 : 11)}
                  textAnchor="middle" fontSize={9} fontWeight={600}
                  fill={isBlocked ? "#ef4444" : "#0d9488"}
                  fontFamily="system-ui"
                  className="select-none pointer-events-none"
                >
                  {occ.name}
                </text>
                {/* Evacuated checkmark */}
                {isEvacuated && (
                  <text x={sx} y={sy - (isWheelchair ? 22 : 19)} textAnchor="middle"
                    fontSize={10} fill="#10b981">✓</text>
                )}
              </g>
            );
          })}
        </svg>

        {/* Animation keyframes */}
        <style>{`
          @keyframes pulse-fire {
            0%, 100% { opacity: 0.3; }
            50% { opacity: 0.7; }
          }
          @keyframes pulse-congestion {
            0%, 100% { opacity: 0.6; }
            50% { opacity: 1; }
          }
        `}</style>

        {/* Legend */}
        <div className="absolute bottom-3 left-3 rounded-lg border border-slate-200 bg-white/95 p-2.5 backdrop-blur shadow-sm">
          <div className="space-y-1 text-[9px]">
            {Object.entries(COLORS).map(([type, c]) => (
              <div key={type} className="flex items-center gap-1.5">
                <span className="h-2 w-3 rounded-sm" style={{ backgroundColor: c.fill, border: `1px solid ${c.stroke}` }} />
                <span className="text-slate-500">{LABELS[type] || type}</span>
              </div>
            ))}
            {fireRoomId && (
              <div className="flex items-center gap-1.5">
                <span className="h-2 w-3 rounded-sm bg-red-100" style={{ border: "1px solid #ef4444" }} />
                <span className="text-red-600">Fire Zone</span>
              </div>
            )}
            {routes.length > 0 && (
              <div className="flex items-center gap-1.5">
                <span className="h-0.5 w-3 rounded" style={{ backgroundColor: "#0d9488" }} />
                <span className="text-slate-500">Evacuation Route</span>
              </div>
            )}
            {occupants.length > 0 && (
              <div className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full bg-teal-500" />
                <span className="text-slate-500">Occupant</span>
              </div>
            )}
            {congestionOverlays.length > 0 && (
              <>
                <div className="flex items-center gap-1.5">
                  <span className="h-2 w-3 rounded-sm bg-red-100" style={{ border: "1px dashed #ef4444" }} />
                  <span className="text-red-600">Bottleneck</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="h-2 w-3 rounded-sm bg-orange-100" style={{ border: "1px dashed #f97316" }} />
                  <span className="text-orange-600">Congested</span>
                </div>
              </>
            )}
            {exitStatuses.length > 0 && (
              <>
                <div className="flex items-center gap-1.5">
                  <span className="h-2 w-3 rounded-sm bg-green-100" style={{ border: "1.5px solid #10b981" }} />
                  <span className="text-green-600">Recommended Exit</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="h-2 w-3 rounded-sm bg-red-100" style={{ border: "1.5px solid #ef4444" }} />
                  <span className="text-red-600">Avoid Exit</span>
                </div>
              </>
            )}
          </div>
        </div>

        {/* Selected element panel */}
        {selectedId && effectiveEditMode && (() => {
          const el = draft.elements.find((e) => e.id === selectedId);
          if (!el) return null;
          return (
            <div className="absolute top-3 right-3 rounded-lg border border-slate-200 bg-white p-3 text-xs shadow-sm min-w-[160px]">
              <p className="font-semibold text-slate-800">{LABELS[el.type] || el.type}</p>
              <p className="text-slate-500 mt-1">Confidence: {Math.round(el.confidence * 100)}%</p>
              <p className="text-slate-400">Position: {Math.round(el.x)}, {Math.round(el.y)}</p>
              <p className="text-slate-400">Size: {Math.round(el.width)} × {Math.round(el.height)}</p>
              {el.source && <p className="text-slate-400">Source: {el.source}</p>}
              <button onClick={() => deleteElement(el.id)}
                className="mt-2 w-full rounded bg-red-50 px-2 py-1 text-[11px] text-red-600 hover:bg-red-100 transition">
                Delete
              </button>
            </div>
          );
        })()}
      </div>

      {/* ── Validation issues ── */}
      {validationIssues.length > 0 && (
        <div className="border-t border-slate-200 px-4 py-2 text-[11px] text-amber-700 bg-amber-50">
          <strong className="text-amber-600">⚠ {validationIssues.length} issue(s):</strong>
          <span className="ml-2">{validationIssues.join(" · ")}</span>
        </div>
      )}
    </div>
  );
}
