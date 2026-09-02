"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import Link from "next/link";
import FloorPlanViewer from "@/components/floorplan/FloorPlanViewer";
import type { RouteOverlay, OccupantOverlay } from "@/components/floorplan/FloorPlanViewer";
import SimulationControls from "@/components/SimulationControls";
import type { SimState } from "@/components/SimulationControls";
import { buildNavigationGraph, getNodesInRoom, getElementCenter } from "@/lib/floorplan-graph";
import type { NavigationGraph } from "@/lib/floorplan-graph";
import { calculateEvacuation } from "@/lib/evacuation-routing";
import type { EvacuationPlan, RouteResult, MobilityType } from "@/lib/evacuation-routing";

/* -------------------------------------------------------
   Types
   ------------------------------------------------------- */

interface ReconResult {
  success: boolean;
  error?: string;
  reconstruction?: {
    photos_received: number;
    photo_groups: number;
    confirmed_overlaps: number;
    camera_poses_estimated: number;
    disconnected_photos: string[][];
    landmark_counts: Record<string, number>;
  };
  detections?: {
    raw_count: number;
    filtered_count: number;
    fused_landmarks: Array<{
      id: string;
      type: string;
      observed_in: string[];
      observation_count: number;
      confidence: number;
      center_x: number;
      center_y: number;
      wheelchair_accessible: boolean;
    }>;
  };
  floor_plan?: {
    width: number;
    height: number;
    units: string;
    approximate: boolean;
    confidence: number;
    elements: Array<{
      id: string;
      type: string;
      x: number;
      y: number;
      width: number;
      height: number;
      confidence: number;
      wheelchair_accessible?: boolean;
      estimated?: boolean;
    }>;
  };
  overlap_details?: Array<{
    image_a: string;
    image_b: string;
    combined_score: number;
    status: string;
  }>;
  validation?: {
    geometry_valid: boolean;
    issues: string[];
  };
  metadata?: {
    overall_confidence: number;
    warning?: string;
  };
}

const STEPS = ["Upload Images", "Analyse Overlap", "Match Landmarks", "Reconstruct Geometry", "Generate Floor Plan", "Validate"];

/* Route colors for multiple occupants */
const ROUTE_COLORS = [
  "#0d9488", // teal-600
  "#0891b2", // cyan-600
  "#059669", // emerald-600
  "#7c3aed", // violet-600
  "#2563eb", // blue-600
  "#d97706", // amber-600
  "#dc2626", // red-600
  "#4f46e5", // indigo-600
];

/* -------------------------------------------------------
   Main Page
   ------------------------------------------------------- */

export default function Reconstruct3DPage() {
  const [photos, setPhotos] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const [processing, setProcessing] = useState(false);
  const [progressStage, setProgressStage] = useState(0);
  const [result, setResult] = useState<ReconResult | null>(null);
  const [error, setError] = useState("");
  const [refType, setRefType] = useState("");
  const [refValue, setRefValue] = useState("");
  const [savedResult, setSavedResult] = useState<ReconResult | null>(null);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const floorPlanRef = useRef<HTMLDivElement>(null);

  /* ---- Simulation state ---- */
  const [fireRoom, setFireRoom] = useState("");
  const [occupants, setOccupants] = useState<Array<{
    id: string; name: string; location_id: string; mobility: string;
  }>>([]);
  const [selectedOccupant, setSelectedOccupant] = useState<string>("");

  /* Navigation graph */
  const [navGraph, setNavGraph] = useState<NavigationGraph | null>(null);

  /* Evacuation plan (routes) */
  const [evacPlan, setEvacPlan] = useState<EvacuationPlan | null>(null);
  const [needsRecalc, setNeedsRecalc] = useState(false);

  /* Animation state */
  const [simState, setSimState] = useState<SimState>("idle");
  const animPositionsRef = useRef<Map<string, { x: number; y: number }>>(new Map());
  const animFrameRef = useRef<number>(0);
  const animStartRef = useRef<number>(0);
  const [animTick, setAnimTick] = useState(0); // force re-renders during animation
  const [animStatuses, setAnimStatuses] = useState<Map<string, string>>(new Map());

  /* ---- Derived data ---- */
  const currentPlan = savedResult?.floor_plan || result?.floor_plan;
  const rooms = currentPlan?.elements.filter((e) => e.type === "room") || [];
  const corridors = currentPlan?.elements.filter((e) => e.type === "corridor") || [];
  const exits = currentPlan?.elements.filter((e) => e.type === "exit") || [];
  const allLocations = [...rooms, ...corridors];

  /* ---- Rebuild graph when floor plan changes ---- */
  useEffect(() => {
    if (!currentPlan || currentPlan.elements.length === 0) {
      setNavGraph(null);
      return;
    }
    const graph = buildNavigationGraph(currentPlan.elements);
    setNavGraph(graph);
    // Mark that routes need recalculation
    if (evacPlan) setNeedsRecalc(true);
  }, [currentPlan]);

  /* ---- Rebuild graph when saved result changes ---- */
  useEffect(() => {
    if (savedResult?.floor_plan) {
      const graph = buildNavigationGraph(savedResult.floor_plan.elements);
      setNavGraph(graph);
    }
  }, [savedResult]);

  /* ---- Photo handling ---- */
  const handlePhotosAdd = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    const newPhotos = Array.from(files);
    setPhotos((prev) => [...prev, ...newPhotos]);
    newPhotos.forEach((file) => {
      setPreviews((prev) => [...prev, URL.createObjectURL(file)]);
    });
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, []);

  const removePhoto = useCallback((index: number) => {
    setPhotos((prev) => prev.filter((_, i) => i !== index));
    setPreviews((prev) => {
      URL.revokeObjectURL(prev[index]);
      return prev.filter((_, i) => i !== index);
    });
  }, []);

  /* ---- Process photos ---- */
  const processPhotos = async () => {
    if (photos.length < 2) {
      setError("Upload at least 2 overlapping photos.");
      return;
    }
    setProcessing(true);
    setError("");
    setResult(null);
    setProgressStage(1);

    const timer = setInterval(() => {
      setProgressStage((p) => Math.min(p + 1, STEPS.length - 1));
    }, 2000);

    try {
      const formData = new FormData();
      photos.forEach((p) => formData.append("photos", p));
      if (refType) formData.append("reference_type", refType);
      if (refValue) formData.append("reference_value", refValue);
      formData.append("floor", "1");

      const r = await fetch("/api/reconstruct", { method: "POST", body: formData });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || "Server error");
      setResult(data);
      setProgressStage(STEPS.length);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Reconstruction failed.");
    } finally {
      clearInterval(timer);
      setProcessing(false);
    }
  };

  /* ---- Save floor plan ---- */
  const handleFloorPlanSave = async (editedPlan: unknown) => {
    setSaveStatus("saving");
    try {
      const r = await fetch("/api/save-floor-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editedPlan),
      });
      const data = await r.json();
      if (data.success) {
        setSavedResult((prev) => prev ? { ...prev, floor_plan: data.floor_plan } : prev);
        setSaveStatus("saved");
        // Clear stale routes
        setEvacPlan(null);
        setNeedsRecalc(true);
      } else {
        setSaveStatus("error");
      }
    } catch {
      setSaveStatus("error");
    }
  };

  const scrollToFloorPlan = () => {
    floorPlanRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  /* ---- Occupant management ---- */
  const addOccupant = () => {
    const firstLocation = rooms[0]?.id || corridors[0]?.id || exits[0]?.id || "";
    setOccupants((prev) => [
      ...prev,
      {
        id: `person_${Date.now()}`,
        name: `Person ${prev.length + 1}`,
        location_id: firstLocation,
        mobility: "normal",
      },
    ]);
    setNeedsRecalc(true);
  };

  /* ---- Calculate evacuation routes ---- */
  const calculateRoutes = useCallback(() => {
    if (!fireRoom || occupants.length === 0 || !navGraph || !currentPlan) return;

    // Find blocked nodes (nodes inside the fire room)
    const blockedNodes = getNodesInRoom(navGraph, fireRoom, currentPlan.elements);

    // Find blocked edges (edges touching blocked nodes)
    const blockedEdges = new Set<string>();
    for (const edge of navGraph.edges) {
      if (blockedNodes.includes(edge.source) || blockedNodes.includes(edge.target)) {
        blockedEdges.add([edge.source, edge.target].sort().join("::"));
      }
    }

    const plan = calculateEvacuation(
      navGraph,
      occupants.map((o) => ({
        id: o.id,
        name: o.name,
        locationId: o.location_id,
        mobility: o.mobility as MobilityType,
      })),
      fireRoom,
      blockedNodes,
      blockedEdges
    );

    setEvacPlan(plan);
    setNeedsRecalc(false);

    // Select first occupant by default
    if (plan.routes.length > 0) {
      setSelectedOccupant(plan.routes[0].occupantId);
    }
  }, [fireRoom, occupants, navGraph, currentPlan]);

  /* ---- Build route overlays for FloorPlanViewer ---- */
  const buildRouteOverlays = useCallback((): RouteOverlay[] => {
    if (!evacPlan) return [];
    return evacPlan.routes
      .filter((r) => r.success && r.routeCoords.length > 0)
      .map((r, i) => ({
        occupantId: r.occupantId,
        points: r.routeCoords,
        color: ROUTE_COLORS[i % ROUTE_COLORS.length],
        isSelected: selectedOccupant === r.occupantId,
      }));
  }, [evacPlan, selectedOccupant]);

  /* ---- Build occupant overlays for FloorPlanViewer ---- */
  const buildOccupantOverlays = useCallback((): OccupantOverlay[] => {
    if (!currentPlan) return [];

    return occupants.map((occ, i) => {
      // Get the animated position or calculate from room center
      const animPos = animPositionsRef.current.get(occ.id);
      if (animPos) {
        const status = animStatuses.get(occ.id) || "waiting";
        return {
          id: occ.id,
          x: animPos.x,
          y: animPos.y,
          mobility: occ.mobility,
          name: occ.name,
          status: status as OccupantOverlay["status"],
        };
      }

      // Default: center of their room
      const center = getElementCenter(currentPlan.elements, occ.location_id);
      if (center) {
        const routeResult = evacPlan?.routes.find((r) => r.occupantId === occ.id);
        let status: OccupantOverlay["status"] = "waiting";
        if (routeResult) {
          if (!routeResult.success) status = routeResult.status;
        }
        return {
          id: occ.id,
          x: center.x,
          y: center.y,
          mobility: occ.mobility,
          name: occ.name,
          status,
        };
      }

      return {
        id: occ.id,
        x: 0,
        y: 0,
        mobility: occ.mobility,
        name: occ.name,
        status: "waiting" as const,
      };
    });
  }, [occupants, currentPlan, evacPlan, animPositionsRef.current, animStatuses, animTick]);

  /* ---- Animation engine ---- */
  const ANIM_SPEED = 2.0; // units per millisecond (world coords)

  const startAnimation = useCallback(() => {
    if (!evacPlan) return;

    // Initialize positions to starting points
    animPositionsRef.current = new Map();
    const statuses = new Map<string, string>();

    for (const route of evacPlan.routes) {
      if (route.success && route.routeCoords.length > 0) {
        const start = route.routeCoords[0];
        animPositionsRef.current.set(route.occupantId, { x: start.x, y: start.y });
        statuses.set(route.occupantId, "evacuating");
      } else {
        // Mark as blocked/no_route
        const occ = occupants.find((o) => o.id === route.occupantId);
        if (occ && currentPlan) {
          const center = getElementCenter(currentPlan.elements, occ.location_id);
          if (center) animPositionsRef.current.set(route.occupantId, { x: center.x, y: center.y });
        }
        statuses.set(route.occupantId, route.status);
      }
    }
    setAnimStatuses(new Map(statuses));

    setSimState("running");
    animStartRef.current = performance.now();

    // Start animation loop
    const animate = (time: number) => {
      const elapsed = time - animStartRef.current;
      let allDone = true;

      for (const route of evacPlan.routes) {
        if (!route.success || route.routeCoords.length < 2) continue;

        const currentStatus = animStatuses.get(route.occupantId);
        if (currentStatus === "evacuated") continue;

        // Calculate total route distance
        let totalDist = 0;
        const segments: number[] = [];
        for (let i = 1; i < route.routeCoords.length; i++) {
          const dx = route.routeCoords[i].x - route.routeCoords[i - 1].x;
          const dy = route.routeCoords[i].y - route.routeCoords[i - 1].y;
          const d = Math.sqrt(dx * dx + dy * dy);
          segments.push(d);
          totalDist += d;
        }

        // Calculate how far along the route we should be
        const targetDist = elapsed * ANIM_SPEED;
        let traveled = 0;

        for (let i = 0; i < segments.length; i++) {
          if (traveled + segments[i] >= targetDist) {
            // We're in this segment
            const t = (targetDist - traveled) / segments[i];
            const from = route.routeCoords[i];
            const to = route.routeCoords[i + 1];
            const px = from.x + (to.x - from.x) * t;
            const py = from.y + (to.y - from.y) * t;
            animPositionsRef.current.set(route.occupantId, { x: px, y: py });
            allDone = false;
            break;
          }
          traveled += segments[i];

          if (i === segments.length - 1) {
            // Reached the end
            const last = route.routeCoords[route.routeCoords.length - 1];
            animPositionsRef.current.set(route.occupantId, { x: last.x, y: last.y });
            statuses.set(route.occupantId, "evacuated");
          }
        }
      }

      setAnimStatuses(new Map(statuses));
      setAnimTick((t) => t + 1); // trigger re-render

      if (!allDone) {
        animFrameRef.current = requestAnimationFrame(animate);
      } else {
        setSimState("paused"); // completed
      }
    };

    animFrameRef.current = requestAnimationFrame(animate);
  }, [evacPlan, occupants, currentPlan]);

  const pauseAnimation = useCallback(() => {
    cancelAnimationFrame(animFrameRef.current);
    setSimState("paused");
  }, []);

  const resumeAnimation = useCallback(() => {
    if (simState !== "paused" || !evacPlan) return;

    // We need to adjust the start time so the animation picks up where it left off
    // Simple approach: just restart the loop but with positions already set
    setSimState("running");
    animStartRef.current = performance.now();

    const animate = (time: number) => {
      // For resume, calculate offset from paused positions
      const elapsed = time - animStartRef.current;
      let allDone = true;
      const statuses = new Map<string, string>(animStatuses);

      for (const route of evacPlan.routes) {
        if (!route.success || route.routeCoords.length < 2) continue;

        const currentStatus = animStatuses.get(route.occupantId);
        if (currentStatus === "evacuated") continue;

        // Find current position in route
        const currentPos = animPositionsRef.current.get(route.occupantId);
        if (!currentPos) continue;

        // Find which segment the occupant is at
        let segIndex = 0;
        let segProgress = 0;
        for (let i = 0; i < route.routeCoords.length - 1; i++) {
          const from = route.routeCoords[i];
          const to = route.routeCoords[i + 1];
          const dx = to.x - from.x;
          const dy = to.y - from.y;
          const segLen = Math.sqrt(dx * dx + dy * dy);
          if (segLen === 0) continue;

          const t = ((currentPos.x - from.x) * dx + (currentPos.y - from.y) * dy) / (segLen * segLen);
          if (t >= 0 && t <= 1.01) {
            segIndex = i;
            segProgress = t;
            break;
          }
        }

        // Calculate remaining distance from current position
        let remainingDist = 0;
        const from = route.routeCoords[segIndex];
        const to = route.routeCoords[segIndex + 1];
        const dx = to.x - from.x;
        const dy = to.y - from.y;
        const segLen = Math.sqrt(dx * dx + dy * dy);
        remainingDist += segLen * (1 - Math.min(segProgress, 1));
        for (let i = segIndex + 1; i < route.routeCoords.length - 1; i++) {
          const sdx = route.routeCoords[i + 1].x - route.routeCoords[i].x;
          const sdy = route.routeCoords[i + 1].y - route.routeCoords[i].y;
          remainingDist += Math.sqrt(sdx * sdx + sdy * sdy);
        }

        const targetDist = elapsed * ANIM_SPEED;

        if (targetDist >= remainingDist) {
          const last = route.routeCoords[route.routeCoords.length - 1];
          animPositionsRef.current.set(route.occupantId, { x: last.x, y: last.y });
          statuses.set(route.occupantId, "evacuated");
        } else {
          // Interpolate from current position
          let traveled = 0;
          let pos = currentPos;

          // Continue from current segment
          const remaining = segLen * (1 - Math.min(segProgress, 1));
          if (targetDist <= remaining) {
            const t = targetDist / remaining;
            pos = {
              x: from.x + dx * t * (1 - segProgress) + dx * segProgress,
              y: from.y + dy * t * (1 - segProgress) + dy * segProgress,
            };
          } else {
            traveled = remaining;
            for (let i = segIndex + 1; i < route.routeCoords.length - 1; i++) {
              const sdx = route.routeCoords[i + 1].x - route.routeCoords[i].x;
              const sdy = route.routeCoords[i + 1].y - route.routeCoords[i].y;
              const sLen = Math.sqrt(sdx * sdx + sdy * sdy);
              if (traveled + sLen >= targetDist) {
                const t = (targetDist - traveled) / sLen;
                pos = {
                  x: route.routeCoords[i].x + sdx * t,
                  y: route.routeCoords[i].y + sdy * t,
                };
                break;
              }
              traveled += sLen;
            }
          }

          animPositionsRef.current.set(route.occupantId, pos);
          allDone = false;
        }
      }

      setAnimStatuses(new Map(statuses));
      setAnimTick((t) => t + 1);

      if (!allDone) {
        animFrameRef.current = requestAnimationFrame(animate);
      } else {
        setSimState("paused");
      }
    };

    animFrameRef.current = requestAnimationFrame(animate);
  }, [simState, evacPlan, animStatuses]);

  const resetAnimation = useCallback(() => {
    cancelAnimationFrame(animFrameRef.current);
    animPositionsRef.current = new Map();
    setAnimStatuses(new Map());
    setSimState("idle");
    setAnimTick((t) => t + 1);
  }, []);

  /* Cleanup animation on unmount */
  useEffect(() => {
    return () => cancelAnimationFrame(animFrameRef.current);
  }, []);

  /* ---- Mark needs recalc when inputs change ---- */
  useEffect(() => {
    if (evacPlan) setNeedsRecalc(true);
    // Reset animation when inputs change
    if (simState === "running" || simState === "paused") {
      cancelAnimationFrame(animFrameRef.current);
      animPositionsRef.current = new Map();
      setAnimStatuses(new Map());
      setSimState("idle");
    }
  }, [fireRoom, occupants]);

  /* ---- Overlays for FloorPlanViewer ---- */
  const routeOverlays = buildRouteOverlays();
  const occupantOverlays = buildOccupantOverlays();

  /* ---- Evacuation plan details for results panel ---- */
  const selectedEvac = evacPlan?.routes.find((r) => r.occupantId === selectedOccupant) || null;

  return (
    <main className="min-h-screen bg-slate-50 text-slate-800">
      {/* ── HEADER ── */}
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-[1200px] items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3">
            <Link href="/" className="flex h-8 w-8 items-center justify-center rounded-lg bg-slate-100 text-sm text-slate-600 hover:bg-slate-200 transition">←</Link>
            <div>
              <h1 className="text-lg font-bold text-slate-800">EVAC-X Reconstructor</h1>
              <p className="text-[11px] text-slate-400">Photo-based building reconstruction & evacuation twin</p>
            </div>
          </div>
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <span className="h-2 w-2 rounded-full bg-teal-500" />
            Ready
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-[1200px] px-6 py-6 space-y-6">
        {/* ── PROGRESS ── */}
        <div className="flex items-center gap-1 overflow-x-auto pb-1">
          {STEPS.map((step, i) => (
            <div key={i} className="flex items-center gap-1">
              <div
                className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[10px] font-medium whitespace-nowrap transition ${
                  i < progressStage
                    ? "bg-teal-50 text-teal-700 border border-teal-200"
                    : i === progressStage && processing
                    ? "bg-teal-50 text-teal-600 animate-pulse border border-teal-200"
                    : "bg-slate-100 text-slate-400 border border-transparent"
                }`}
              >
                {i < progressStage ? "✓" : i === progressStage && processing ? "●" : `${i + 1}`}
                {step}
              </div>
              {i < STEPS.length - 1 && (
                <div className={`h-px w-3 ${i < progressStage ? "bg-teal-300" : "bg-slate-200"}`} />
              )}
            </div>
          ))}
        </div>

        {/* ══════════════════════════════════════════ STEP 1 — UPLOAD ══════════════════════════════════════════ */}
        <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="mb-2 text-sm font-semibold text-slate-800">Step 1 — Upload Building Views</h2>
          <p className="mb-4 text-[11px] text-slate-500">
            Capture photos while walking through the building. Ensure 40–70% overlap between consecutive views.
          </p>
          <div className="flex items-center gap-3">
            <label className="cursor-pointer rounded-xl border border-slate-200 bg-slate-50 px-5 py-2.5 text-sm font-medium text-slate-700 transition hover:border-teal-400 hover:bg-white">
              📷 Upload Images
              <input ref={fileInputRef} type="file" accept="image/*" multiple onChange={handlePhotosAdd} className="hidden" />
            </label>
            {photos.length > 0 && <span className="text-xs text-slate-400">{photos.length} photos</span>}
          </div>
          {photos.length > 0 && (
            <div className="mt-3 flex gap-3 items-end">
              <div>
                <label className="mb-1 block text-[10px] text-slate-400">Reference (optional)</label>
                <select value={refType} onChange={(e) => setRefType(e.target.value)} className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-700 outline-none focus:border-teal-400 focus:ring-1 focus:ring-teal-400">
                  <option value="">None</option>
                  <option value="door_width">Door width (m)</option>
                  <option value="corridor_width">Corridor width (m)</option>
                </select>
              </div>
              <input
                type="number" step="0.01" placeholder="0.9"
                value={refValue} onChange={(e) => setRefValue(e.target.value)}
                disabled={!refType}
                className="w-24 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-700 outline-none focus:border-teal-400 disabled:opacity-40"
              />
            </div>
          )}
        </section>

        {/* ══════════════════════════════════════════ STEP 2 — CAROUSEL ══════════════════════════════════════════ */}
        {photos.length > 0 && (
          <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-semibold text-slate-800">Step 2 — Building Views</h2>
              <span className="text-[10px] text-slate-400">{photos.length} Photos</span>
            </div>
            <ImageCarousel previews={previews} onRemove={removePhoto} />
          </section>
        )}

        {/* ══════════════════════════════════════════ STEP 3 — ANALYSE ══════════════════════════════════════════ */}
        {photos.length >= 2 && !result && (
          <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <h2 className="mb-4 text-sm font-semibold text-slate-800">Step 3 — Analyse Building</h2>
            <button
              onClick={processPhotos}
              disabled={processing}
              className="w-full rounded-xl bg-teal-600 px-6 py-3 text-sm font-semibold text-white transition hover:bg-teal-700 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {processing
                ? `Processing... (${STEPS[Math.min(progressStage, STEPS.length - 1)]})`
                : "Reconstruct Floor Plan"}
            </button>
          </section>
        )}

        {error && (
          <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-600">{error}</div>
        )}

        {/* ══════════════════════════════════════════ STEP 3 RESULTS ══════════════════════════════════════════ */}
        {result && result.reconstruction && (
          <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <h2 className="mb-4 text-sm font-semibold text-slate-800">Step 3 — Analysis Complete</h2>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <AnalysisStat label="Photos" value={String(result.reconstruction.photos_received)} />
              <AnalysisStat label="Overlaps" value={String(result.reconstruction.confirmed_overlaps)} />
              <AnalysisStat label="Landmarks" value={String(result.detections?.fused_landmarks.length || 0)} />
              <AnalysisStat label="Confidence" value={Math.round((result.metadata?.overall_confidence || 0) * 100) + "%"} highlight />
            </div>
            {result.metadata?.overall_confidence && result.metadata.overall_confidence > 0 && (
              <button onClick={scrollToFloorPlan} className="mt-4 text-xs text-teal-600 hover:text-teal-700 transition">
                View Floor Plan ↓
              </button>
            )}
          </section>
        )}

        {/* ══════════════════════════════════════════ STEP 4 — FLOOR PLAN ══════════════════════════════════════════ */}
        <div ref={floorPlanRef} id="floor-plan-section">
          {processing && (
            <section className="rounded-xl border border-slate-200 bg-white p-12 text-center shadow-sm">
              <div className="text-sm text-slate-500">Reconstructing building geometry...</div>
              <div className="mt-2 text-[11px] text-slate-400">The 2D floor plan will appear here when analysis is complete.</div>
            </section>
          )}

          {result && result.floor_plan && result.floor_plan.elements.length > 0 && (
            <section className="space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-slate-800">Step 4 — Generated 2D Floor Plan</h2>
                <span className="text-[10px] text-slate-400">
                  {result.floor_plan.approximate ? "Estimated Prototype Reconstruction" : "Reconstructed"}
                </span>
              </div>

              {/* Floor plan with simulation overlays */}
              <FloorPlanViewer
                floorPlan={result.floor_plan}
                onSave={handleFloorPlanSave}
                fireRoomId={simState !== "idle" || evacPlan ? fireRoom : undefined}
                routes={routeOverlays}
                occupants={occupantOverlays}
                simulationMode={simState === "running" || simState === "paused"}
              />

              {saveStatus === "saved" && (
                <div className="rounded-lg bg-teal-50 border border-teal-200 px-4 py-2 text-xs text-teal-700">
                  ✓ Floor plan saved. Navigation graph updated.
                </div>
              )}
              {saveStatus === "error" && (
                <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-2 text-xs text-red-600">
                  ✗ Failed to save. Please try again.
                </div>
              )}

              {/* Landmarks list */}
              {result.detections && result.detections.fused_landmarks.length > 0 && (
                <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
                  <h3 className="mb-3 text-xs font-semibold uppercase tracking-widest text-slate-400">
                    Confirmed Landmarks ({result.detections.fused_landmarks.length})
                  </h3>
                  <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
                    {result.detections.fused_landmarks.map((lm) => (
                      <div key={lm.id} className="flex items-center justify-between rounded-lg bg-slate-50 border border-slate-100 px-3 py-2 text-[11px]">
                        <span className="flex items-center gap-1.5 text-slate-700">
                          <span>{typeIcon(lm.type)}</span>
                          <span>{lm.type}</span>
                        </span>
                        <span className="text-slate-400">×{lm.observation_count} · {Math.round(lm.confidence * 100)}%</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {result.validation && !result.validation.geometry_valid && (
                <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-xs text-amber-700">
                  <strong className="text-amber-600">⚠️ Validation Issues:</strong>
                  <ul className="mt-2 list-disc pl-5 space-y-1">
                    {result.validation.issues.map((issue, i) => (
                      <li key={i}>{issue}</li>
                    ))}
                  </ul>
                </div>
              )}
            </section>
          )}

          {/* ══════════════════════════════════════════ STEP 5 — EVACUATION ══════════════════════════════════════════ */}
          {result?.floor_plan && result.floor_plan.elements.length > 0 && (
            <section className="rounded-xl border border-slate-200 bg-white p-5 space-y-4 shadow-sm">
              <h2 className="text-sm font-semibold text-slate-800">Step 5 — Emergency Evacuation Simulation</h2>

              <div className="grid gap-4 md:grid-cols-2">
                {/* Fire controls */}
                <div className="space-y-3">
                  <label className="text-[11px] text-slate-400 uppercase tracking-wider">Hazard Type</label>
                  <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-600">
                    🔥 Fire
                  </div>
                  <label className="text-[11px] text-slate-400 uppercase tracking-wider">Start Fire In</label>
                  <select
                    value={fireRoom}
                    onChange={(e) => setFireRoom(e.target.value)}
                    className="w-full rounded-lg bg-white border border-slate-200 px-3 py-2 text-xs text-slate-700 outline-none focus:border-red-400 focus:ring-1 focus:ring-red-400"
                  >
                    <option value="">Select room...</option>
                    {rooms.map((r) => (
                      <option key={r.id} value={r.id}>{r.id}</option>
                    ))}
                    {corridors.map((c) => (
                      <option key={c.id} value={c.id}>{c.id} (corridor)</option>
                    ))}
                  </select>
                </div>

                {/* Occupants */}
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <label className="text-[11px] text-slate-400 uppercase tracking-wider">Occupants</label>
                    <button onClick={addOccupant}
                      className="rounded bg-teal-50 border border-teal-200 px-2 py-0.5 text-[10px] text-teal-600 hover:bg-teal-100 transition">
                      + Add Person
                    </button>
                  </div>
                  {occupants.length === 0 && (
                    <p className="text-[10px] text-slate-400">No occupants added yet.</p>
                  )}
                  {occupants.map((occ, idx) => (
                    <div key={occ.id} className="rounded-lg bg-slate-50 border border-slate-200 p-2 space-y-1.5">
                      <div className="flex items-center justify-between">
                        <input
                          value={occ.name}
                          onChange={(e) => {
                            const next = [...occupants];
                            next[idx] = { ...next[idx], name: e.target.value };
                            setOccupants(next);
                          }}
                          className="bg-transparent text-xs text-slate-700 outline-none w-24"
                        />
                        <button onClick={() => setOccupants((p) => p.filter((_, i) => i !== idx))}
                          className="text-[10px] text-red-400 hover:text-red-600">✕</button>
                      </div>
                      <select
                        value={occ.location_id}
                        onChange={(e) => {
                          const next = [...occupants];
                          next[idx] = { ...next[idx], location_id: e.target.value };
                          setOccupants(next);
                        }}
                        className="w-full rounded bg-white border border-slate-200 px-2 py-1 text-[10px] text-slate-700 outline-none"
                      >
                        {allLocations.map((l) => (
                          <option key={l.id} value={l.id}>{l.id}</option>
                        ))}
                      </select>
                      <div className="flex gap-2">
                        {["normal", "wheelchair", "limited_mobility"].map((m) => (
                          <label key={m} className="flex items-center gap-1 text-[10px] text-slate-500 cursor-pointer">
                            <input type="radio" name={`mobility-${occ.id}`} checked={occ.mobility === m}
                              onChange={() => {
                                const next = [...occupants];
                                next[idx] = { ...next[idx], mobility: m };
                                setOccupants(next);
                              }}
                              className="accent-teal-600"
                            />
                            {m === "wheelchair" ? "♿ Wheelchair" : m === "limited_mobility" ? "🚶 Limited" : "✓ Normal"}
                          </label>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Calculate button */}
              <button
                onClick={calculateRoutes}
                disabled={!fireRoom || occupants.length === 0 || !navGraph}
                className="rounded-xl bg-red-600 px-5 py-2 text-xs font-semibold text-white hover:bg-red-700 transition disabled:opacity-40 shadow-sm"
              >
                {needsRecalc && evacPlan ? "⚠ Recalculate Evacuation Routes" : "🔥 Calculate Evacuation Routes"}
              </button>

              {/* Stale route warning */}
              {needsRecalc && evacPlan && (
                <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-[11px] text-amber-700">
                  ⚠ Floor plan changed. Recalculate evacuation routes.
                </div>
              )}

              {/* Simulation controls */}
              {evacPlan && (
                <SimulationControls
                  state={simState}
                  onStart={startAnimation}
                  onPause={pauseAnimation}
                  onResume={resumeAnimation}
                  onReset={resetAnimation}
                  onRecalculate={calculateRoutes}
                  needsRecalculation={needsRecalc}
                  hasRoutes={evacPlan.routes.some((r) => r.success)}
                  hasFire={!!fireRoom}
                  hasOccupants={occupants.length > 0}
                />
              )}

              {/* Evacuation results */}
              {evacPlan?.routes && evacPlan.routes.length > 0 && (
                <div className="space-y-3">
                  <p className="text-xs font-semibold text-slate-600">EVACUATION STATUS</p>

                  {/* Occupant tabs */}
                  <div className="flex items-center gap-2 flex-wrap">
                    {evacPlan.routes.map((ev, i) => (
                      <button
                        key={ev.occupantId}
                        onClick={() => setSelectedOccupant(ev.occupantId)}
                        className={`rounded-lg px-3 py-1.5 text-[11px] font-medium transition ${
                          selectedOccupant === ev.occupantId
                            ? "bg-teal-50 text-teal-700 border border-teal-200"
                            : "bg-slate-50 text-slate-500 border border-slate-200 hover:bg-slate-100"
                        }`}
                      >
                        {ev.occupantName}
                        {occupants.find((o) => o.id === ev.occupantId)?.mobility === "wheelchair" ? " ♿" : ""}
                        {ev.status === "evacuated" ? " ✓" : ""}
                        {ev.status === "blocked" || ev.status === "no_route" ? " ⚠" : ""}
                      </button>
                    ))}
                  </div>

                  {/* Selected occupant details */}
                  {selectedEvac && (
                    <div className="rounded-xl bg-slate-50 border border-slate-200 p-4 space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-semibold text-slate-800">{selectedEvac.occupantName}</span>
                        <span className={`text-[10px] px-2 py-0.5 rounded-full ${
                          selectedEvac.success
                            ? "bg-teal-50 text-teal-700 border border-teal-200"
                            : "bg-red-50 text-red-600 border border-red-200"
                        }`}>
                          {selectedEvac.success ? "✓ Route Found" : "✕ No Route"}
                        </span>
                      </div>
                      <div className="grid grid-cols-2 gap-2 text-[11px]">
                        <div><span className="text-slate-400">Mobility:</span> <span className="text-slate-600">{occupants.find((o) => o.id === selectedEvac.occupantId)?.mobility}</span></div>
                        {selectedEvac.success && (
                          <>
                            <div><span className="text-slate-400">Exit:</span> <span className="text-slate-600">{selectedEvac.recommendedExit}</span></div>
                            <div><span className="text-slate-400">Risk:</span> <span className={`font-semibold ${
                              selectedEvac.risk === "LOW" ? "text-teal-600" : selectedEvac.risk === "MEDIUM" ? "text-amber-600" : "text-red-600"
                            }`}>{selectedEvac.risk}</span></div>
                            <div><span className="text-slate-400">Distance:</span> <span className="text-slate-600">{Math.round(selectedEvac.distance)}m</span></div>
                          </>
                        )}
                      </div>
                      {/* Wheelchair accessibility indicators */}
                      {occupants.find((o) => o.id === selectedEvac.occupantId)?.mobility === "wheelchair" && selectedEvac.success && (
                        <div className="flex gap-3 text-[10px]">
                          <span className={selectedEvac.usesStairs ? "text-red-600" : "text-teal-600"}>
                            {selectedEvac.usesStairs ? "⚠ Uses stairs" : "✓ No stairs"}
                          </span>
                          <span className={selectedEvac.usesRamp ? "text-teal-600" : "text-slate-400"}>
                            {selectedEvac.usesRamp ? "✓ Uses ramp" : "No ramp"}
                          </span>
                          <span className={selectedEvac.accessibleRoute ? "text-teal-600" : "text-red-600"}>
                            {selectedEvac.accessibleRoute ? "✓ Accessible Route" : "✕ Inaccessible Route"}
                          </span>
                        </div>
                      )}
                      {/* Route path */}
                      {selectedEvac.success && selectedEvac.route && selectedEvac.route.length > 0 && (
                        <div className="mt-2">
                          <p className="text-[10px] text-slate-400 mb-1">Route:</p>
                          <div className="flex items-center gap-1 flex-wrap">
                            {selectedEvac.route.map((node: string, i: number) => (
                              <span key={i} className="flex items-center gap-1">
                                <span className="rounded bg-white border border-slate-200 px-1.5 py-0.5 text-[10px] text-slate-600">{node}</span>
                                {i < selectedEvac.route.length - 1 && <span className="text-slate-300">→</span>}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                      {!selectedEvac.success && (
                        <p className="text-[11px] text-red-500">{selectedEvac.message}</p>
                      )}
                    </div>
                  )}
                </div>
              )}
            </section>
          )}

          {result && result.floor_plan && result.floor_plan.elements.length === 0 && (
            <section className="rounded-xl border border-amber-200 bg-amber-50 p-8 text-center">
              <p className="text-sm text-amber-700">Unable to generate a reliable floor plan.</p>
              <p className="mt-2 text-[11px] text-amber-600">
                Some building areas could not be reconstructed. Please add more overlapping photographs or review the detected landmarks.
              </p>
            </section>
          )}
        </div>
      </div>
    </main>
  );
}

/* -------------------------------------------------------
   IMAGE CAROUSEL
   ------------------------------------------------------- */

function ImageCarousel({ previews, onRemove }: { previews: string[]; onRemove: (index: number) => void }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const scroll = (dir: -1 | 1) => {
    if (scrollRef.current) scrollRef.current.scrollBy({ left: dir * 220, behavior: "smooth" });
  };

  return (
    <div className="relative">
      <button onClick={() => scroll(-1)}
        className="absolute left-0 top-1/2 -translate-y-1/2 z-10 flex h-8 w-8 items-center justify-center rounded-full bg-white border border-slate-200 text-slate-600 text-sm hover:bg-slate-50 transition shadow-sm">←</button>
      <div ref={scrollRef} className="flex gap-3 overflow-x-auto scroll-smooth px-10 py-2" style={{ flexWrap: "nowrap" }}>
        {previews.map((src, i) => (
          <div key={i} className="relative flex-shrink-0 w-[180px] group">
            <div className="aspect-[4/3] overflow-hidden rounded-xl border border-slate-200 bg-white">
              <img src={src} alt={`View ${i + 1}`} className="h-full w-full object-cover" />
            </div>
            <div className="absolute left-2 top-2 rounded bg-teal-600 px-1.5 py-0.5 text-[10px] font-bold text-white">{i + 1}</div>
            <button onClick={() => onRemove(i)}
              className="absolute right-2 top-2 rounded bg-white border border-slate-200 px-1 py-0.5 text-[10px] text-red-500 opacity-0 group-hover:opacity-100 transition hover:bg-red-50 shadow-sm">✕</button>
          </div>
        ))}
      </div>
      <button onClick={() => scroll(1)}
        className="absolute right-0 top-1/2 -translate-y-1/2 z-10 flex h-8 w-8 items-center justify-center rounded-full bg-white border border-slate-200 text-slate-600 text-sm hover:bg-slate-50 transition shadow-sm">→</button>
    </div>
  );
}

/* -------------------------------------------------------
   Small components
   ------------------------------------------------------- */

function AnalysisStat({ label, value, highlight = false }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="rounded-xl bg-slate-50 border border-slate-200 p-3">
      <p className="text-[10px] text-slate-400">{label}</p>
      <p className={`mt-1 text-lg font-bold ${highlight ? "text-teal-600" : "text-slate-800"}`}>{value}</p>
    </div>
  );
}

function typeIcon(type: string): string {
  const m: Record<string, string> = {
    door: "🚪", "exit sign": "↗", "emergency exit": "↗",
    stairs: "▥", elevator: "🛗", ramp: "♿", corridor: "━",
  };
  return m[type] || "●";
}
