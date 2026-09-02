"use client";

import { useState, useRef, useCallback } from "react";
import Link from "next/link";

type Mobility =
  | "normal"
  | "wheelchair"
  | "elderly"
  | "temporary_injury";

type FloorPlanElement = {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  label?: string;
  wheelchair_accessible?: boolean;
};

type GraphNode = {
  id: string;
  type: string;
  x: number;
  y: number;
  label?: string;
  confidence?: number;
};

type GraphEdge = {
  source: string;
  target: string;
  distance: number;
  blocked?: boolean;
};

type ReconstructionResult = {
  success: boolean;
  error?: string;
  analysis?: {
    photos_processed: number;
    detections: number;
    overlap_relationships: number;
  };
  floor_plan?: {
    floor: number;
    elements: FloorPlanElement[];
    rooms: Record<string, unknown>[];
  };
  navigation_graph?: {
    nodes: GraphNode[];
    edges: GraphEdge[];
  };
  routing_graph?: {
    nodes: GraphNode[];
    edges: GraphEdge[];
  };
  metadata?: {
    scale_mode: string;
    approximate: boolean;
    overall_confidence: number;
    warning?: string;
  };
  route?: {
    success: boolean;
    route: string[];
    recommended_exit: string;
    cost: number;
    risk: string;
  };
};

function normalizeCoord(
  val: number,
  nodes: GraphNode[],
  isY: boolean = false
): number {
  if (nodes.length === 0) return 50;
  const vals = nodes.map((n) => (isY ? n.y : n.x));
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  if (max === min) return 50;
  return 10 + ((val - min) / (max - min)) * 80;
}

function formatNodeId(id: string): string {
  const names: Record<string, string> = {
    start: "YOU ARE HERE",
    corridor_1: "CORRIDOR 1",
    corridor_2: "CORRIDOR 2",
    corridor_3: "CORRIDOR 3",
  };
  return names[id] || id.replaceAll("_", " ").toUpperCase();
}

function typeIcon(type: string): string {
  const map: Record<string, string> = {
    corridor: "━",
    door: "🚪",
    room: "🏠",
    stairs: "▥",
    ramp: "♿",
    elevator: "🛗",
    exit: "↗",
    entrance: "▼",
  };
  return map[type] || "●";
}

export default function ReconstructPage() {
  const [photos, setPhotos] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const [processing, setProcessing] = useState(false);
  const [result, setResult] =
    useState<ReconstructionResult | null>(null);
  const [error, setError] = useState("");
  const [refType, setRefType] = useState("");
  const [refValue, setRefValue] = useState("");
  const [mobility, setMobility] =
    useState<Mobility>("normal");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handlePhotosAdd = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (!files) return;
      const newPhotos = Array.from(files);
      setPhotos((prev) => [...prev, ...newPhotos]);
      newPhotos.forEach((file) => {
        const url = URL.createObjectURL(file);
        setPreviews((prev) => [...prev, url]);
      });
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    },
    []
  );

  const removePhoto = useCallback((index: number) => {
    setPhotos((prev) => prev.filter((_, i) => i !== index));
    setPreviews((prev) => {
      URL.revokeObjectURL(prev[index]);
      return prev.filter((_, i) => i !== index);
    });
  }, []);

  const movePhoto = useCallback(
    (from: number, to: number) => {
      if (to < 0 || to >= photos.length) return;
      setPhotos((prev) => {
        const arr = [...prev];
        const [item] = arr.splice(from, 1);
        arr.splice(to, 0, item);
        return arr;
      });
      setPreviews((prev) => {
        const arr = [...prev];
        const [item] = arr.splice(from, 1);
        arr.splice(to, 0, item);
        return arr;
      });
    },
    [photos.length]
  );

  const processPhotos = async () => {
    if (photos.length === 0) {
      setError("Please upload at least one photo.");
      return;
    }
    setProcessing(true);
    setError("");
    setResult(null);
    try {
      const formData = new FormData();
      photos.forEach((photo) => {
        formData.append("photos", photo);
      });
      if (refType) {
        formData.append("reference_type", refType);
      }
      if (refValue) {
        formData.append("reference_value", refValue);
      }
      formData.append("floor", "1");
      formData.append("mobility", mobility);
      const response = await fetch("/api/photo-reconstruction", {
        method: "POST",
        body: formData,
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Server error");
      }
      setResult(data);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Photo reconstruction failed."
      );
    } finally {
      setProcessing(false);
    }
  };

  return (
    <main className="min-h-screen bg-[#07111f] text-white">
      <header className="border-b border-white/10 bg-[#091525]">
        <div className="mx-auto flex max-w-[1500px] items-center justify-between px-8 py-5">
          <div className="flex items-center gap-3">
            <Link
              href="/"
              className="flex h-10 w-10 items-center justify-center rounded-xl bg-purple-500 text-xl transition hover:bg-purple-400"
            >
              ←
            </Link>
            <div>
              <h1 className="text-xl font-bold">
                Photo-Based Floor Plan
              </h1>
              <p className="text-xs text-slate-400">
                AI-generated approximate navigable floor plan from
                building photos
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-purple-400" />
            <span className="text-sm text-purple-300">
              RECONSTRUCTION MODE
            </span>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-[1500px] px-8 py-8">
        {/* WARNING */}
        <div className="mb-6 rounded-xl border border-yellow-500/20 bg-yellow-500/5 p-4 text-xs leading-relaxed text-yellow-200/70">
          <strong className="text-yellow-300">
            ⚠️ AI-Generated Approximation:
          </strong>{" "}
          This floor plan is generated from photos and is an
          approximate reconstruction. Please review and correct
          it before relying on it for evacuation planning.
        </div>

        {/* STEP 1 */}
        <section className="mb-6 rounded-2xl border border-white/10 bg-[#0b1829] p-6">
          <div className="mb-4 flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-purple-500/20 text-sm font-bold text-purple-300">
              1
            </div>
            <div>
              <h2 className="font-semibold">
                Upload Building Photos
              </h2>
              <p className="text-xs text-slate-400">
                Upload photos in capture order while walking
                through the building.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <label className="cursor-pointer rounded-xl border border-white/10 bg-[#07111f] px-5 py-3 text-sm font-medium transition hover:border-purple-400">
              📷 Add Photos
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                onChange={handlePhotosAdd}
                className="hidden"
              />
            </label>
            {photos.length > 0 && (
              <span className="text-sm text-slate-400">
                {photos.length} photo
                {photos.length !== 1 ? "s" : ""} selected
              </span>
            )}
          </div>
          {photos.length > 0 && (
            <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
              {photos.map((photo, i) => (
                <div
                  key={i}
                  className="group relative overflow-hidden rounded-xl border border-white/10 bg-[#07111f]"
                >
                  <div className="aspect-[4/3] overflow-hidden">
                    <img
                      src={previews[i]}
                      alt={"Photo " + (i + 1)}
                      className="h-full w-full object-cover"
                    />
                  </div>
                  <div className="absolute left-0 top-0 flex items-center gap-1 rounded-br-lg bg-black/70 px-2 py-1 text-xs font-bold text-white">
                    {i + 1}
                  </div>
                  <div className="absolute right-0 top-0 flex gap-0.5 rounded-bl-lg bg-black/70 p-1 opacity-0 transition group-hover:opacity-100">
                    <button
                      onClick={() => movePhoto(i, i - 1)}
                      disabled={i === 0}
                      className="rounded px-1 text-xs text-white hover:bg-white/20 disabled:opacity-30"
                    >
                      ←
                    </button>
                    <button
                      onClick={() => movePhoto(i, i + 1)}
                      disabled={i === photos.length - 1}
                      className="rounded px-1 text-xs text-white hover:bg-white/20 disabled:opacity-30"
                    >
                      →
                    </button>
                    <button
                      onClick={() => removePhoto(i)}
                      className="rounded px-1 text-xs text-red-400 hover:bg-red-500/20"
                    >
                      ✕
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* STEP 2 */}
        <section className="mb-6 rounded-2xl border border-white/10 bg-[#0b1829] p-6">
          <div className="mb-4 flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-purple-500/20 text-sm font-bold text-purple-300">
              2
            </div>
            <h2 className="font-semibold">
              Settings & Reference
            </h2>
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            <div>
              <label className="mb-2 block text-xs text-slate-400">
                Reference Measurement (optional)
              </label>
              <select
                value={refType}
                onChange={(e) => setRefType(e.target.value)}
                className="w-full rounded-xl border border-white/10 bg-[#07111f] px-4 py-3 text-sm outline-none focus:border-purple-400"
              >
                <option value="">
                  No reference (relative scale)
                </option>
                <option value="door_width">Door width</option>
                <option value="corridor_width">
                  Corridor width
                </option>
                <option value="entrance_width">
                  Entrance width
                </option>
                <option value="stair_width">
                  Stair width
                </option>
              </select>
            </div>
            <div>
              <label className="mb-2 block text-xs text-slate-400">
                Measured Value (meters)
              </label>
              <input
                type="number"
                step="0.01"
                placeholder="e.g. 0.9"
                value={refValue}
                onChange={(e) => setRefValue(e.target.value)}
                disabled={!refType}
                className="w-full rounded-xl border border-white/10 bg-[#07111f] px-4 py-3 text-sm outline-none focus:border-purple-400 disabled:opacity-40"
              />
            </div>
            <div>
              <label className="mb-2 block text-xs text-slate-400">
                Mobility Profile
              </label>
              <select
                value={mobility}
                onChange={(e) =>
                  setMobility(e.target.value as Mobility)
                }
                className="w-full rounded-xl border border-white/10 bg-[#07111f] px-4 py-3 text-sm outline-none focus:border-purple-400"
              >
                <option value="normal">Normal</option>
                <option value="wheelchair">
                  ♿ Wheelchair
                </option>
                <option value="elderly">👴 Elderly</option>
                <option value="temporary_injury">
                  🩼 Temporary Injury
                </option>
              </select>
            </div>
          </div>
        </section>

        {/* PROCESS BUTTON */}
        <div className="mb-6 flex justify-center">
          <button
            onClick={processPhotos}
            disabled={photos.length === 0 || processing}
            className="rounded-xl bg-purple-500 px-8 py-4 text-base font-semibold transition hover:bg-purple-400 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {processing
              ? "🤖 Processing Photos..."
              : "✨ Generate Floor Plan (" + photos.length + " photos)"}
          </button>
        </div>

        {error && (
          <div className="mb-6 rounded-xl border border-red-500/20 bg-red-500/10 p-4 text-sm text-red-300">
            {error}
          </div>
        )}

        {/* RESULTS */}
        {result && (
          <ResultsPanel result={result} mobility={mobility} />
        )}
      </div>
    </main>
  );
}

/* -------------------------------------------------------
   Results Panel (separated for cleanliness)
   ------------------------------------------------------- */

function ResultsPanel({
  result,
  mobility,
}: {
  result: ReconstructionResult;
  mobility: Mobility;
}) {
  const nodes = result.navigation_graph?.nodes ?? [];

  return (
    <>
      {result.analysis && (
        <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4">
          <StatCard
            icon="📷"
            label="Photos"
            value={String(result.analysis.photos_processed)}
            sub="processed"
          />
          <StatCard
            icon="🔍"
            label="Detections"
            value={String(result.analysis.detections)}
            sub="objects found"
          />
          <StatCard
            icon="🔗"
            label="Overlaps"
            value={String(result.analysis.overlap_relationships)}
            sub="connected pairs"
          />
          <StatCard
            icon="📊"
            label="Confidence"
            value={
              Math.round(
                (result.metadata?.overall_confidence ?? 0) * 100
              ) + "%"
            }
            sub={result.metadata?.scale_mode || "relative"}
          />
        </div>
      )}

      {result.metadata?.warning && (
        <div className="mb-6 rounded-xl border border-yellow-500/20 bg-yellow-500/5 p-4 text-xs text-yellow-200/70">
          <strong className="text-yellow-300">Note:</strong>{" "}
          {result.metadata.warning}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_390px]">
        {/* Floor Plan */}
        <section className="overflow-hidden rounded-2xl border border-white/10 bg-[#0b1829]">
          <div className="flex items-center justify-between border-b border-white/10 px-6 py-4">
            <div>
              <h2 className="font-semibold">
                Generated Floor Plan
              </h2>
              <p className="text-xs text-slate-400">
                AI-reconstructed approximate layout
              </p>
            </div>
            <div className="rounded-lg bg-purple-500/10 px-3 py-1.5 text-xs text-purple-300">
              APPROXIMATE
            </div>
          </div>
          <div className="relative min-h-[620px] overflow-hidden bg-[#081321]">
            <div
              className="absolute inset-0 opacity-20"
              style={{
                backgroundImage:
                  "linear-gradient(rgba(255,255,255,.08) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.08) 1px, transparent 1px)",
                backgroundSize: "40px 40px",
              }}
            />

            {result.floor_plan?.elements.map((el) => (
              <FloorPlanElementView key={el.id} element={el} />
            ))}

            {result.navigation_graph?.edges.map((edge, i) => {
              const src = nodes.find(
                (n) => n.id === edge.source
              );
              const tgt = nodes.find(
                (n) => n.id === edge.target
              );
              if (!src || !tgt) return null;
              const x1 = normalizeCoord(src.x, nodes);
              const y1 = normalizeCoord(src.y, nodes, true);
              const x2 = normalizeCoord(tgt.x, nodes);
              const y2 = normalizeCoord(tgt.y, nodes, true);
              return (
                <svg
                  key={"edge-" + i}
                  className="pointer-events-none absolute inset-0 h-full w-full"
                >
                  <line
                    x1={x1 + "%"}
                    y1={y1 + "%"}
                    x2={x2 + "%"}
                    y2={y2 + "%"}
                    stroke="rgba(168,85,247,0.4)"
                    strokeWidth="2"
                    strokeDasharray="6,4"
                  />
                </svg>
              );
            })}

            {nodes.map((node) => (
              <NavNode key={node.id} node={node} allNodes={nodes} />
            ))}

            <div className="absolute bottom-5 left-5 rounded-xl border border-white/10 bg-[#0b1829]/90 p-4 backdrop-blur">
              <p className="mb-3 text-xs font-semibold text-slate-400">
                LEGEND
              </p>
              <div className="space-y-2 text-xs">
                <LegendItem color="bg-slate-500" text="Corridor" />
                <LegendItem color="bg-blue-400" text="Door" />
                <LegendItem color="bg-yellow-400" text="Stairs" />
                <LegendItem
                  color="bg-emerald-400"
                  text="Ramp / Elevator"
                />
                <LegendItem color="bg-red-400" text="Exit" />
                <LegendItem color="bg-purple-400" text="Room" />
              </div>
            </div>
          </div>
        </section>

        {/* Side Panel */}
        <aside className="space-y-6">
          {result.route && (
            <section className="rounded-2xl border border-white/10 bg-[#0b1829] p-6">
              <p className="text-xs font-semibold uppercase tracking-widest text-slate-500">
                Recommended Evacuation
              </p>
              <h2 className="mt-2 text-3xl font-bold">
                {result.route.recommended_exit || "No route"}
              </h2>
              {result.route.success && (
                <div className="mt-4 space-y-2">
                  {result.route.route.map((node, i) => (
                    <div
                      key={node + "-" + i}
                      className="flex items-center gap-3"
                    >
                      <div className="flex h-7 w-7 items-center justify-center rounded-full bg-purple-500/10 text-xs text-purple-300">
                        {i + 1}
                      </div>
                      <span className="text-sm">
                        {formatNodeId(node)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}

          <section className="rounded-2xl border border-white/10 bg-[#0b1829] p-6">
            <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-slate-500">
              Generated Elements
            </p>
            <div className="max-h-[300px] space-y-2 overflow-y-auto">
              {result.floor_plan?.elements.map((el) => (
                <div
                  key={el.id}
                  className="flex items-center justify-between rounded-lg bg-[#07111f] px-3 py-2 text-xs"
                >
                  <span className="flex items-center gap-2">
                    <span>{typeIcon(el.type)}</span>
                    <span>{el.label || el.id}</span>
                  </span>
                  <span className="text-slate-500">
                    {el.type}
                  </span>
                </div>
              ))}
            </div>
          </section>

          <div className="rounded-xl border border-purple-500/20 bg-purple-500/5 p-4 text-xs leading-relaxed text-purple-200/70">
            <strong className="text-purple-300">
              Next steps:
            </strong>{" "}
            Review the generated elements above. The floor plan is
            approximate — verify door positions, room sizes, and
            exit locations against the actual building.
          </div>
        </aside>
      </div>
    </>
  );
}

/* -------------------------------------------------------
   Small UI helpers
   ------------------------------------------------------- */

function StatCard({
  icon,
  label,
  value,
  sub,
}: {
  icon: string;
  label: string;
  value: string;
  sub: string;
}) {
  return (
    <div className="rounded-2xl border border-white/10 bg-[#0b1829] p-5">
      <div className="mb-3 flex items-center justify-between">
        <span className="text-xl">{icon}</span>
        <span className="text-xs text-slate-500">LIVE</span>
      </div>
      <p className="text-xs text-slate-400">{label}</p>
      <p className="mt-1 text-2xl font-bold">{value}</p>
      <p className="mt-1 text-xs text-slate-500">{sub}</p>
    </div>
  );
}

function FloorPlanElementView({
  element,
}: {
  element: FloorPlanElement;
}) {
  const typeColors: Record<string, string> = {
    corridor: "bg-slate-700/60 border-slate-500/40",
    door: "bg-blue-500/30 border-blue-400/50",
    room: "bg-purple-500/15 border-purple-400/30",
    stairs: "bg-yellow-500/20 border-yellow-400/40",
    ramp: "bg-emerald-500/20 border-emerald-400/40",
    elevator: "bg-emerald-500/20 border-emerald-400/40",
    exit: "bg-red-500/20 border-red-400/40",
    entrance: "bg-orange-500/20 border-orange-400/40",
  };

  const scale = 30;
  const cx = 450;
  const cy = 310;
  const left = cx + element.x * scale;
  const top = cy + element.y * scale;
  const w = Math.max(element.width * scale, 8);
  const h = Math.max(element.height * scale, 8);
  const colorClass =
    typeColors[element.type] ||
    "bg-slate-600/30 border-slate-400/30";

  return (
    <div
      className={
        "absolute rounded border " + colorClass
      }
      style={{ left: left + "px", top: top + "px", width: w + "px", height: h + "px" }}
      title={element.type + ": " + (element.label || element.id)}
    >
      {w > 40 && h > 20 && (
        <span className="flex h-full items-center justify-center text-[9px] font-medium text-white/60">
          {element.label || element.type}
        </span>
      )}
    </div>
  );
}

function NavNode({
  node,
  allNodes,
}: {
  node: GraphNode;
  allNodes: GraphNode[];
}) {
  const scale = 30;
  const cx = 450;
  const cy = 310;
  const x = cx + node.x * scale;
  const y = cy + node.y * scale;

  const iconMap: Record<string, string> = {
    corridor: "━━",
    door: "🚪",
    stairs: "▥",
    ramp: "♿",
    elevator: "🛗",
    exit: "↗",
    entrance: "▼",
    junction: "⊕",
  };

  const shortLabel = (node.label || node.id).split(" (P")[0];

  return (
    <div
      className="absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center"
      style={{ left: x + "px", top: y + "px" }}
      title={node.type + ": " + (node.label || node.id)}
    >
      <div className="flex h-10 w-10 items-center justify-center rounded-full border-2 border-purple-400/60 bg-purple-500/20 text-sm">
        {iconMap[node.type] || "●"}
      </div>
      <span className="mt-1 whitespace-nowrap text-[9px] font-semibold text-purple-300/80">
        {shortLabel}
      </span>
    </div>
  );
}

function LegendItem({
  color,
  text,
}: {
  color: string;
  text: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className={"h-2 w-2 rounded-full " + color} />
      <span className="text-slate-400">{text}</span>
    </div>
  );
}
