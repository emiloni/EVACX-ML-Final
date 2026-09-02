"use client";

import { useState, useRef, useCallback } from "react";
import Link from "next/link";
import FloorPlanViewer from "@/components/floorplan/FloorPlanViewer";

/* -------------------------------------------------------
   Types
   ------------------------------------------------------- */

type MobilityType = "normal" | "wheelchair" | "limited_mobility";

interface EvacuationItem {
  occupant_id: string;
  occupant_name: string;
  success: boolean;
  route: string[];
  recommended_exit: string;
  mobility: string;
  distance: number;
  risk: string;
  uses_stairs: boolean;
  uses_ramp: boolean;
  accessible_route?: boolean;
  reason?: string;
  message?: string;
}

interface EvacuationResult {
  success: boolean;
  evacuations: EvacuationItem[];
  hazard?: {
    room_id: string;
    blocked_nodes: string[];
  };
}

type ReconResult = {
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
};

const STEPS = ["Upload Images", "Analyse Overlap", "Match Landmarks", "Reconstruct Geometry", "Generate Floor Plan", "Validate"];

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

  // Evacuation simulation state
  const [fireRoom, setFireRoom] = useState("");
  const [occupants, setOccupants] = useState<Array<{
    id: string; name: string; location_id: string; mobility: string;
  }>>([]);
  const [evacResult, setEvacResult] = useState<EvacuationResult | null>(null);
  const [evacLoading, setEvacLoading] = useState(false);
  const [selectedOccupant, setSelectedOccupant] = useState<string>("");
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const floorPlanRef = useRef<HTMLDivElement>(null);

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

  const addOccupant = () => {
    const rooms = (result?.floor_plan?.elements || []).filter((e) => e.type === "room");
    const exits = (result?.floor_plan?.elements || []).filter((e) => e.type === "exit");
    const corridors = (result?.floor_plan?.elements || []).filter((e) => e.type === "corridor");
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
  };

  const runEvacuation = async () => {
    if (!fireRoom || occupants.length === 0) return;
    const plan = result?.floor_plan;
    if (!plan) return;
    setEvacLoading(true);
    setEvacResult(null);
    try {
      const r = await fetch("/api/evacuate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          floor_plan: plan,
          fire_room_id: fireRoom,
          occupants,
        }),
      });
      const data = await r.json();
      setEvacResult(data);
      if (data.evacuations?.length > 0) {
        setSelectedOccupant(data.evacuations[0].occupant_id);
      }
    } catch {
      setEvacResult({ success: false, evacuations: [] });
    } finally {
      setEvacLoading(false);
    }
  };

  const currentPlan = result?.floor_plan;
  const rooms = currentPlan?.elements.filter((e) => e.type === "room") || [];
  const corridors = currentPlan?.elements.filter((e) => e.type === "corridor") || [];
  const allLocations = [...rooms, ...corridors];

  const evacList = evacResult?.evacuations || [];
  const selectedEvac = evacList.find((e) => e.occupant_id === selectedOccupant) || null;

  return (
    <main className="min-h-screen bg-slate-50 text-slate-800">
      {/* ── HEADER ── */}
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-[1200px] items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3">
            <Link href="/" className="flex h-8 w-8 items-center justify-center rounded-lg bg-slate-100 text-sm text-slate-600 hover:bg-slate-200 transition">←</Link>
            <div>
              <h1 className="text-lg font-bold text-slate-800">EVAC-X Reconstructor</h1>
              <p className="text-[11px] text-slate-400">Photo-based building reconstruction</p>
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

        {/* ══════════════════════════════════════════
            STEP 1 — UPLOAD
            ══════════════════════════════════════════ */}
        <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="mb-2 text-sm font-semibold text-slate-800">Step 1 — Upload Building Views</h2>
          <p className="mb-4 text-[11px] text-slate-500">
            Capture photos while walking through the building. Ensure 40–70% overlap between consecutive views.
          </p>

          <div className="flex items-center gap-3">
            <label className="cursor-pointer rounded-xl border border-slate-200 bg-slate-50 px-5 py-2.5 text-sm font-medium text-slate-700 transition hover:border-teal-400 hover:bg-white">
              📷 Upload Images
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
              <span className="text-xs text-slate-400">{photos.length} photos</span>
            )}
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
                className="w-24 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-700 outline-none focus:border-teal-400 focus:ring-1 focus:ring-teal-400 disabled:opacity-40"
              />
            </div>
          )}
        </section>

        {/* ══════════════════════════════════════════
            STEP 2 — IMAGE CAROUSEL
            ══════════════════════════════════════════ */}
        {photos.length > 0 && (
          <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-semibold text-slate-800">Step 2 — Building Views</h2>
              <span className="text-[10px] text-slate-400">{photos.length} Photos</span>
            </div>
            <ImageCarousel previews={previews} onRemove={removePhoto} />
          </section>
        )}

        {/* ══════════════════════════════════════════
            STEP 3 — ANALYSE
            ══════════════════════════════════════════ */}
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

        {/* ══════════════════════════════════════════
            STEP 3 (results) — ANALYSIS SUMMARY
            ══════════════════════════════════════════ */}
        {result && result.reconstruction && (
          <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <h2 className="mb-4 text-sm font-semibold text-slate-800">Step 3 — Analysis Complete</h2>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <AnalysisStat label="Photos" value={String(result.reconstruction.photos_received)} />
              <AnalysisStat label="Overlaps" value={String(result.reconstruction.confirmed_overlaps)} />
              <AnalysisStat label="Landmarks" value={String(result.detections?.fused_landmarks.length || 0)} />
              <AnalysisStat
                label="Confidence"
                value={Math.round((result.metadata?.overall_confidence || 0) * 100) + "%"}
                highlight
              />
            </div>
            {result.metadata?.overall_confidence && result.metadata.overall_confidence > 0 && (
              <button
                onClick={scrollToFloorPlan}
                className="mt-4 text-xs text-teal-600 hover:text-teal-700 transition"
              >
                View Floor Plan ↓
              </button>
            )}
          </section>
        )}

        {/* ══════════════════════════════════════════
            STEP 4 — FLOOR PLAN (below the fold)
            ══════════════════════════════════════════ */}
        <div ref={floorPlanRef} id="floor-plan-section">
          {processing && (
            <section className="rounded-xl border border-slate-200 bg-white p-12 text-center shadow-sm">
              <div className="text-sm text-slate-500">Reconstructing building geometry...</div>
              <div className="mt-2 text-[11px] text-slate-400">
                The 2D floor plan will appear here when analysis is complete.
              </div>
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
              <FloorPlanViewer floorPlan={result.floor_plan} onSave={handleFloorPlanSave} />
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
                        <span className="text-slate-400">
                          ×{lm.observation_count} · {Math.round(lm.confidence * 100)}%
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Validation */}
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

          {/* ── EVACUATION SIMULATION ── */}
          {result?.floor_plan && result.floor_plan.elements.length > 0 && (
            <section className="rounded-xl border border-slate-200 bg-white p-5 space-y-4 shadow-sm">
              <h2 className="text-sm font-semibold text-slate-800">Step 5 — Emergency Evacuation Simulation</h2>

              <div className="grid gap-4 md:grid-cols-2">
                {/* Fire input */}
                <div className="space-y-2">
                  <label className="text-[11px] text-slate-400 uppercase tracking-wider">Hazard Type</label>
                  <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-600">
                    🔥 Fire
                  </div>
                  <label className="text-[11px] text-slate-400 uppercase tracking-wider">Fire Location</label>
                  <select
                    value={fireRoom}
                    onChange={(e) => setFireRoom(e.target.value)}
                    className="w-full rounded-lg bg-white border border-slate-200 px-3 py-2 text-xs text-slate-700 outline-none focus:border-red-400 focus:ring-1 focus:ring-red-400"
                  >
                    <option value="">Select room...</option>
                    {rooms.map((r) => (
                      <option key={r.id} value={r.id}>{r.id} ({r.type})</option>
                    ))}
                    {corridors.map((c) => (
                      <option key={c.id} value={c.id}>{c.id} (corridor)</option>
                    ))}
                  </select>
                </div>

                {/* Occupants */}
                <div className="space-y-2">
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

              <button
                onClick={runEvacuation}
                disabled={!fireRoom || occupants.length === 0 || evacLoading}
                className="rounded-xl bg-red-600 px-5 py-2 text-xs font-semibold text-white hover:bg-red-700 transition disabled:opacity-40 shadow-sm"
              >
                {evacLoading ? "Calculating routes..." : "🔥 Calculate Evacuation Routes"}
              </button>

              {/* Results */}
              {evacResult?.evacuations && (
                <div className="space-y-3">
                  <div className="flex items-center gap-2 flex-wrap">
                    {evacResult.evacuations.map((ev) => (
                      <button
                        key={ev.occupant_id}
                        onClick={() => setSelectedOccupant(ev.occupant_id)}
                        className={`rounded-lg px-3 py-1.5 text-[11px] font-medium transition ${
                          selectedOccupant === ev.occupant_id
                            ? "bg-teal-50 text-teal-700 border border-teal-200"
                            : "bg-slate-50 text-slate-500 border border-slate-200 hover:bg-slate-100"
                        }`}
                      >
                        {ev.occupant_name} {ev.mobility === "wheelchair" ? "♿" : ""}
                      </button>
                    ))}
                  </div>

                  {/* Selected occupant route */}
                  {selectedEvac && (
                    <div className="rounded-xl bg-slate-50 border border-slate-200 p-4 space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-semibold text-slate-800">{selectedEvac.occupant_name}</span>
                        <span className={`text-[10px] px-2 py-0.5 rounded-full ${
                          selectedEvac.success ? "bg-teal-50 text-teal-700 border border-teal-200" : "bg-red-50 text-red-600 border border-red-200"
                        }`}>
                          {selectedEvac.success ? "Route found" : "No route"}
                        </span>
                      </div>
                      <div className="grid grid-cols-2 gap-2 text-[11px]">
                        <div><span className="text-slate-400">Mobility:</span> <span className="text-slate-600">{selectedEvac.mobility}</span></div>
                        <div><span className="text-slate-400">Exit:</span> <span className="text-slate-600">{selectedEvac.recommended_exit}</span></div>
                        <div><span className="text-slate-400">Risk:</span> <span className={`font-semibold ${
                          selectedEvac.risk === "LOW" ? "text-teal-600" : selectedEvac.risk === "MEDIUM" ? "text-amber-600" : "text-red-600"
                        }`}>{selectedEvac.risk}</span></div>
                        <div><span className="text-slate-400">Distance:</span> <span className="text-slate-600">{selectedEvac.distance}</span></div>
                      </div>
                      {selectedEvac.mobility === "wheelchair" && (
                        <div className="flex gap-3 text-[10px]">
                          <span className={selectedEvac.uses_stairs ? "text-red-600" : "text-teal-600"}>
                            {selectedEvac.uses_stairs ? "⚠ Uses stairs" : "✓ No stairs"}
                          </span>
                          <span className={selectedEvac.uses_ramp ? "text-teal-600" : "text-slate-400"}>
                            {selectedEvac.uses_ramp ? "✓ Uses ramp" : "No ramp"}
                          </span>
                        </div>
                      )}
                      {selectedEvac.success && selectedEvac.route && (
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
              <p className="text-sm text-amber-700">
                Unable to generate a reliable floor plan.
              </p>
              <p className="mt-2 text-[11px] text-amber-600">
                Some building areas could not be reconstructed. Please add more overlapping photographs
                or review the detected landmarks.
              </p>
            </section>
          )}
        </div>
      </div>
    </main>
  );
}

/* -------------------------------------------------------
   IMAGE CAROUSEL — horizontal, no wrapping
   ------------------------------------------------------- */

function ImageCarousel({
  previews,
  onRemove,
}: {
  previews: string[];
  onRemove: (index: number) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  const scroll = (dir: -1 | 1) => {
    if (scrollRef.current) {
      scrollRef.current.scrollBy({ left: dir * 220, behavior: "smooth" });
    }
  };

  return (
    <div className="relative">
      {/* Left arrow */}
      <button
        onClick={() => scroll(-1)}
        className="absolute left-0 top-1/2 -translate-y-1/2 z-10 flex h-8 w-8 items-center justify-center rounded-full bg-white border border-slate-200 text-slate-600 text-sm hover:bg-slate-50 transition shadow-sm"
      >
        ←
      </button>

      {/* Scrollable container — NO WRAP */}
      <div
        ref={scrollRef}
        className="flex gap-3 overflow-x-auto scroll-smooth px-10 py-2"
        style={{ flexWrap: "nowrap" }}
      >
        {previews.map((src, i) => (
          <div
            key={i}
            className="relative flex-shrink-0 w-[180px] group"
          >
            <div className="aspect-[4/3] overflow-hidden rounded-xl border border-slate-200 bg-white">
              <img
                src={src}
                alt={`View ${i + 1}`}
                className="h-full w-full object-cover"
              />
            </div>
            {/* Index badge */}
            <div className="absolute left-2 top-2 rounded bg-teal-600 px-1.5 py-0.5 text-[10px] font-bold text-white">
              {i + 1}
            </div>
            {/* Remove button */}
            <button
              onClick={() => onRemove(i)}
              className="absolute right-2 top-2 rounded bg-white border border-slate-200 px-1 py-0.5 text-[10px] text-red-500 opacity-0 group-hover:opacity-100 transition hover:bg-red-50 shadow-sm"
            >
              ✕
            </button>
          </div>
        ))}
      </div>

      {/* Right arrow */}
      <button
        onClick={() => scroll(1)}
        className="absolute right-0 top-1/2 -translate-y-1/2 z-10 flex h-8 w-8 items-center justify-center rounded-full bg-white border border-slate-200 text-slate-600 text-sm hover:bg-slate-50 transition shadow-sm"
      >
        →
      </button>
    </div>
  );
}

/* -------------------------------------------------------
   Small components
   ------------------------------------------------------- */

function AnalysisStat({
  label,
  value,
  highlight = false,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
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
