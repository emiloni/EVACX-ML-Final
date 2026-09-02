"use client";

import {
  useState, useRef, useCallback, useMemo, useEffect,
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
  source?: string; // "ai_detected" | "user_added" | "user_corrected"
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

interface FloorPlanViewerProps {
  floorPlan: FloorPlanData;
  onChange?: (plan: FloorPlanData) => void;
  onSave?: (plan: FloorPlanData) => void;
  className?: string;
}

/* ============================================================
   Constants
   ============================================================ */

const GRID_SIZE = 20;
const SNAP_THRESHOLD = 15;
const HISTORY_LIMIT = 50;

const COLORS: Record<string, { fill: string; stroke: string; text: string }> = {
  corridor: { fill: "#334155", stroke: "#64748b", text: "#94a3b8" },
  door: { fill: "#2563eb", stroke: "#3b82f6", text: "#93c5fd" },
  room: { fill: "#3b0764", stroke: "#7c3aed", text: "#c4b5fd" },
  stairs: { fill: "#854d0e", stroke: "#eab308", text: "#fde047" },
  ramp: { fill: "#065f46", stroke: "#10b981", text: "#6ee7b7" },
  elevator: { fill: "#065f46", stroke: "#10b981", text: "#6ee7b7" },
  exit: { fill: "#991b1b", stroke: "#ef4444", text: "#fca5a5" },
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

  // --- Validation ---
  const [validationIssues, setValidationIssues] = useState<string[]>([]);

  const containerRef = useRef<HTMLDivElement>(null);

  // Sync draft when floorPlan prop changes
  useEffect(() => {
    setDraft(floorPlan);
    setHistory([]);
    setHistoryIndex(-1);
    setUnsaved(false);
    setSelectedId(null);
    setValidationIssues([]);
  }, [floorPlan]);

  // --- Coordinate transforms ---
  const worldToScreen = useCallback(
    (wx: number, wy: number) => {
      const pad = 40;
      return {
        x: pad + wx * zoom + pan.x,
        y: pad + wy * zoom + pan.y,
      };
    },
    [zoom, pan]
  );

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
      if (!editMode) return;
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
  }, [editMode, selectedId, undo, redo]);

  // --- Element operations ---
  const updateElement = useCallback((id: string, changes: Partial<FloorElement>) => {
    setDraft((prev) => {
      const elements = prev.elements.map((e) =>
        e.id === id ? { ...e, ...changes } : e
      );
      return { ...prev, elements };
    });
    setUnsaved(true);
  }, []);

  const deleteElement = useCallback((id: string) => {
    const el = draft.elements.find((e) => e.id === id);
    if (!el) return;
    pushHistory({ type: "delete", elementId: id, before: el, after: null });
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
    setDraft((prev) => ({ ...prev, elements: [...prev.elements, newEl] }));
    setAddType(null);
    setSelectedId(id);
    setUnsaved(true);
  }, [pushHistory, snapToGridFn]);

  // --- Validation ---
  const validate = useCallback(() => {
    const issues: string[] = [];
    const elements = draft.elements;
    // Check corridors exist
    if (!elements.some((e) => e.type === "corridor")) issues.push("No corridor element");
    // Check exits exist
    if (!elements.some((e) => e.type === "exit")) issues.push("No exit element");
    // Check room overlap
    const rooms = elements.filter((e) => e.type === "room");
    for (let i = 0; i < rooms.length; i++) {
      for (let j = i + 1; j < rooms.length; j++) {
        const a = rooms[i], b = rooms[j];
        const ox = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
        const oy = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
        if (ox > 0 && oy > 0) issues.push(`Room overlap: ${a.id} and ${b.id}`);
      }
    }
    // Check exit near corridor
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
    // Mark all as user_corrected
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
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;

    // Add mode — place element
    if (addType && editMode) {
      const world = screenToWorld(sx, sy);
      addElement(addType, world.x, world.y);
      return;
    }

    // Check if clicked on an element
    if (editMode) {
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

    // Pan
    setDragging(true);
    dragRef.current = {
      elementId: null, startX: e.clientX, startY: e.clientY,
      origX: pan.x, origY: pan.y, isPan: true,
    };
  }, [editMode, addType, draft.elements, screenToWorld, pan, addElement]);

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

  return (
    <div className={`rounded-2xl border border-white/10 bg-[#0b1829] overflow-hidden ${className}`}>
      {/* ── Toolbar ── */}
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-2 flex-wrap gap-2">
        <div className="flex items-center gap-3">
          <h3 className="text-sm font-semibold">2D Floor Plan</h3>
          {unsaved && <span className="text-[10px] text-yellow-400">● Unsaved changes</span>}
        </div>

        <div className="flex items-center gap-1.5 flex-wrap">
          {/* Mode toggle */}
          <button
            onClick={() => { setEditMode(false); setSelectedId(null); setAddType(null); }}
            className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition ${
              !editMode ? "bg-white/15 text-white" : "bg-white/5 text-slate-400 hover:bg-white/10"
            }`}
          >View</button>
          <button
            onClick={() => setEditMode(true)}
            className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition ${
              editMode ? "bg-purple-500/30 text-purple-300" : "bg-white/5 text-slate-400 hover:bg-white/10"
            }`}
          >Edit</button>

          <div className="w-px h-4 bg-white/10 mx-1" />

          {/* Undo/Redo */}
          <button onClick={undo} disabled={historyIndex < 0}
            className="rounded-md bg-white/5 px-2 py-1 text-[11px] hover:bg-white/10 disabled:opacity-30"
            title="Undo (Ctrl+Z)">↩</button>
          <button onClick={redo} disabled={historyIndex >= history.length - 1}
            className="rounded-md bg-white/5 px-2 py-1 text-[11px] hover:bg-white/10 disabled:opacity-30"
            title="Redo (Ctrl+Shift+Z)">↪</button>

          <div className="w-px h-4 bg-white/10 mx-1" />

          {/* Zoom */}
          <button onClick={() => setZoom((z) => Math.min(z + 0.2, 4))}
            className="rounded-md bg-white/5 px-2 py-1 text-[11px] hover:bg-white/10">+</button>
          <button onClick={() => setZoom((z) => Math.max(z - 0.2, 0.2))}
            className="rounded-md bg-white/5 px-2 py-1 text-[11px] hover:bg-white/10">−</button>
          <button onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }}
            className="rounded-md bg-white/5 px-2 py-1 text-[11px] hover:bg-white/10">Fit</button>
          <span className="text-[10px] text-slate-500 w-8 text-right">{Math.round(zoom * 100)}%</span>

          {editMode && (
            <>
              <div className="w-px h-4 bg-white/10 mx-1" />
              <button onClick={() => setShowGrid((g) => !g)}
                className={`rounded-md px-2 py-1 text-[11px] ${showGrid ? "bg-white/15 text-white" : "bg-white/5 text-slate-400 hover:bg-white/10"}`}>
                Grid
              </button>
              <button onClick={() => setSnapToGrid((s) => !s)}
                className={`rounded-md px-2 py-1 text-[11px] ${snapToGrid ? "bg-white/15 text-white" : "bg-white/5 text-slate-400 hover:bg-white/10"}`}>
                Snap
              </button>
            </>
          )}

          <div className="w-px h-4 bg-white/10 mx-1" />

          <button onClick={validate}
            className="rounded-md bg-white/5 px-2.5 py-1 text-[11px] hover:bg-white/10">Validate</button>
          <button onClick={handleSave} disabled={!unsaved || validationIssues.length > 0}
            className="rounded-md bg-emerald-500/20 px-2.5 py-1 text-[11px] text-emerald-300 hover:bg-emerald-500/30 disabled:opacity-40">
            Save
          </button>
        </div>
      </div>

      {/* ── Add toolbar (edit mode only) ── */}
      {editMode && (
        <div className="flex items-center gap-1.5 border-b border-white/5 px-4 py-1.5">
          <span className="text-[10px] text-slate-500 mr-1">Add:</span>
          {ADDABLE_TYPES.map((t) => (
            <button key={t} onClick={() => setAddType(addType === t ? null : t)}
              className={`rounded px-2 py-0.5 text-[10px] font-medium transition ${
                addType === t ? "bg-purple-500/30 text-purple-300" : "bg-white/5 text-slate-400 hover:bg-white/10"
              }`}>
              + {LABELS[t] || t}
            </button>
          ))}
          {addType && (
            <span className="text-[10px] text-purple-300 ml-2">Click on floor plan to place {LABELS[addType]}</span>
          )}
        </div>
      )}

      {/* ── Canvas ── */}
      <div
        ref={containerRef}
        className={`relative min-h-[520px] overflow-hidden bg-[#081321] select-none ${
          editMode ? (addType ? "cursor-crosshair" : "cursor-default") : "cursor-grab active:cursor-grabbing"
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
          {showGrid && editMode && (
            <defs>
              <pattern id="grid" width={GRID_SIZE * zoom} height={GRID_SIZE * zoom} patternUnits="userSpaceOnUse">
                <path d={`M ${GRID_SIZE * zoom} 0 L 0 0 0 ${GRID_SIZE * zoom}`}
                  fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="0.5" />
              </pattern>
            </defs>
          )}
          {showGrid && editMode && (
            <rect width="100%" height="100%" fill="url(#grid)" style={{ transform: `translate(${pan.x}px, ${pan.y}px)` }} />
          )}

          {/* Elements */}
          {sorted.map((el) => {
            const c = COLORS[el.type] || { fill: "#374151", stroke: "#6b7280", text: "#9ca3af" };
            const isLow = el.confidence < 0.4;
            const isSel = selectedId === el.id;
            const isUserAdded = el.source === "user_added";
            const x = pad + el.x * zoom;
            const y = pad + el.y * zoom;
            const w = Math.max(el.width * zoom, 2);
            const h = Math.max(el.height * zoom, 2);

            return (
              <g key={el.id}>
                <rect
                  x={x} y={y} width={w} height={h}
                  rx={el.type === "door" ? 1 : 3}
                  fill={c.fill}
                  stroke={isSel ? "#a78bfa" : isUserAdded ? "#22d3ee" : c.stroke}
                  strokeWidth={isSel ? 2.5 : 1.5}
                  strokeDasharray={isLow && !isUserAdded ? "4,2" : undefined}
                  opacity={isLow && !isUserAdded ? 0.6 : 0.85}
                  style={{ cursor: editMode ? "pointer" : "inherit" }}
                />
                {w > 35 && h > 14 && (
                  <text x={x + w / 2} y={y + h / 2} textAnchor="middle"
                    dominantBaseline="central" fill={c.text}
                    fontSize={Math.min(9, w / 6)} fontFamily="system-ui" fontWeight={600} opacity={0.8}>
                    {LABELS[el.type] || el.type}
                  </text>
                )}
                {isLow && !isUserAdded && <text x={x + w - 6} y={y + 2} fontSize={8} fill="#facc15">⚠</text>}
                {isUserAdded && <text x={x + 2} y={y + 10} fontSize={7} fill="#22d3ee">+</text>}
                {/* Selection handles */}
                {isSel && editMode && (
                  <>
                    <rect x={x - 3} y={y - 3} width={6} height={6} fill="#a78bfa" rx={1} />
                    <rect x={x + w - 3} y={y - 3} width={6} height={6} fill="#a78bfa" rx={1} />
                    <rect x={x - 3} y={y + h - 3} width={6} height={6} fill="#a78bfa" rx={1} />
                    <rect x={x + w - 3} y={y + h - 3} width={6} height={6} fill="#a78bfa" rx={1} />
                  </>
                )}
              </g>
            );
          })}
        </svg>

        {/* Legend */}
        <div className="absolute bottom-3 left-3 rounded-lg border border-white/10 bg-[#0b1829]/90 p-2.5 backdrop-blur">
          <div className="space-y-1 text-[9px]">
            {Object.entries(COLORS).map(([type, c]) => (
              <div key={type} className="flex items-center gap-1.5">
                <span className="h-2 w-3 rounded-sm" style={{ backgroundColor: c.fill, border: `1px solid ${c.stroke}` }} />
                <span className="text-slate-400">{LABELS[type] || type}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Selected element panel */}
        {selectedId && editMode && (() => {
          const el = draft.elements.find((e) => e.id === selectedId);
          if (!el) return null;
          return (
            <div className="absolute top-3 right-3 rounded-lg border border-white/10 bg-[#0b1829]/95 p-3 text-xs backdrop-blur min-w-[160px]">
              <p className="font-semibold text-white">{LABELS[el.type] || el.type}</p>
              <p className="text-slate-400 mt-1">Confidence: {Math.round(el.confidence * 100)}%</p>
              <p className="text-slate-500">Position: {Math.round(el.x)}, {Math.round(el.y)}</p>
              <p className="text-slate-500">Size: {Math.round(el.width)} × {Math.round(el.height)}</p>
              {el.source && <p className="text-slate-500">Source: {el.source}</p>}
              <button onClick={() => deleteElement(el.id)}
                className="mt-2 w-full rounded bg-red-500/20 px-2 py-1 text-[11px] text-red-300 hover:bg-red-500/30 transition">
                Delete
              </button>
            </div>
          );
        })()}
      </div>

      {/* ── Validation issues ── */}
      {validationIssues.length > 0 && (
        <div className="border-t border-white/5 px-4 py-2 text-[11px] text-yellow-200/70">
          <strong className="text-yellow-300">⚠ {validationIssues.length} issue(s):</strong>
          <span className="ml-2">{validationIssues.join(" · ")}</span>
        </div>
      )}
    </div>
  );
}
