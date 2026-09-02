"use client";

import { useState, useCallback, useRef } from "react";
import Link from "next/link";

// ============================================================
// Types
// ============================================================

type CreationMode = "choice" | "floor-plan" | "no-floor-plan" | "result";

type FloorPlanData = {
  width: number;
  height: number;
  elements: Array<{
    id: string;
    type: string;
    x: number;
    y: number;
    width: number;
    height: number;
    confidence?: number;
    wheelchair_accessible?: boolean;
  }>;
};

type PhotoReconResult = {
  success: boolean;
  error?: string;
  analysis?: {
    photos_processed: number;
    detections: number;
    overlap_relationships: number;
  };
  floor_plan?: FloorPlanData;
  navigation_graph?: {
    nodes: Array<{ id: string; type: string; x: number; y: number; label?: string }>;
    edges: Array<{ source: string; target: string; distance: number }>;
  };
  metadata?: {
    overall_confidence: number;
    approximate: boolean;
    warning: string;
  };
};

type ReconstructionResult = {
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
  floor_plan?: FloorPlanData;
  detections?: {
    fused_landmarks: Array<{
      id: string;
      type: string;
      confidence: number;
      center_x: number;
      center_y: number;
    }>;
  };
  metadata?: {
    overall_confidence: number;
    approximate: boolean;
    warning: string;
  };
};

type OccupancyZone = {
  zone_id: string;
  zone_name: string;
  zone_type: string;
  current_people: number;
  maximum_capacity: number;
  occupancy_ratio: number;
  congestion_status: string;
};

// ============================================================
// Constants
// ============================================================

const API =
  process.env.NEXT_PUBLIC_BACKEND_HTTP || "http://127.0.0.1:8000";

const ELEMENT_COLORS: Record<string, { bg: string; border: string; text: string }> = {
  corridor: { bg: "bg-slate-100", border: "border-slate-300", text: "text-slate-600" },
  door: { bg: "bg-teal-50", border: "border-teal-300", text: "text-teal-700" },
  room: { bg: "bg-white", border: "border-slate-200", text: "text-slate-600" },
  stairs: { bg: "bg-amber-50", border: "border-amber-300", text: "text-amber-700" },
  ramp: { bg: "bg-emerald-50", border: "border-emerald-300", text: "text-emerald-700" },
  elevator: { bg: "bg-emerald-50", border: "border-emerald-300", text: "text-emerald-700" },
  exit: { bg: "bg-red-50", border: "border-red-300", text: "text-red-700" },
};

const CONGESTION_COLORS: Record<string, { dot: string; bg: string; text: string }> = {
  NORMAL: { dot: "bg-teal-500", bg: "bg-teal-50", text: "text-teal-700" },
  HIGH_OCCUPANCY: { dot: "bg-amber-500", bg: "bg-amber-50", text: "text-amber-700" },
  CONGESTED: { dot: "bg-orange-500", bg: "bg-orange-50", text: "text-orange-700" },
  BOTTLENECK: { dot: "bg-red-500", bg: "bg-red-50", text: "text-red-700" },
};

// ============================================================
// Page Component
// ============================================================

export default function NewBuildingPage() {
  // --- Creation mode ---
  const [mode, setMode] = useState<CreationMode>("choice");

  // --- Floor plan flow ---
  const [floorPlanImage, setFloorPlanImage] = useState<File | null>(null);
  const [floorPlanPreview, setFloorPlanPreview] = useState<string | null>(null);
  const [floorPlanData, setFloorPlanData] = useState<FloorPlanData | null>(null);
  const [floorPlanLoading, setFloorPlanLoading] = useState(false);

  // --- No-floor-plan flow ---
  const [photos, setPhotos] = useState<File[]>([]);
  const [photoPreviews, setPhotoPreviews] = useState<string[]>([]);
  const [photoLoading, setPhotoLoading] = useState(false);
  const [photoResult, setPhotoResult] = useState<PhotoReconResult | null>(null);
  const [multiResult, setMultiResult] = useState<ReconstructionResult | null>(null);
  const [useAdvancedPipeline, setUseAdvancedPipeline] = useState(false);

  // --- Occupancy monitoring ---
  const [occupancyZones, setOccupancyZones] = useState<OccupancyZone[]>([]);
  const [occupancyImage, setOccupancyImage] = useState<File | null>(null);
  const [occupancyCamera, setOccupancyCamera] = useState("camera_1");
  const [occupancyZone, setOccupancyZone] = useState("zone_main");
  const [occupancyZoneName, setOccupancyZoneName] = useState("Main Area");
  const [occupancyCapacity, setOccupancyCapacity] = useState(20);
  const [occupancyLoading, setOccupancyLoading] = useState(false);
  const [occupancyResult, setOccupancyResult] = useState<any>(null);

  // --- Errors ---
  const [error, setError] = useState("");

  const photoInputRef = useRef<HTMLInputElement>(null);
  const floorPlanInputRef = useRef<HTMLInputElement>(null);
  const occupancyInputRef = useRef<HTMLInputElement>(null);

  // ============================================================
  // Floor Plan Flow
  // ============================================================

  const handleFloorPlanSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      setFloorPlanImage(file);
      setFloorPlanPreview(URL.createObjectURL(file));
      setError("");
    },
    []
  );

  const analyzeFloorPlan = useCallback(async () => {
    if (!floorPlanImage) {
      setError("Please select a floor plan image first.");
      return;
    }
    setFloorPlanLoading(true);
    setError("");
    try {
      const formData = new FormData();
      formData.append("file", floorPlanImage);
      const res = await fetch(`${API}/api/analyze-and-route?mobility=normal`, {
        method: "POST",
        body: formData,
      });
      if (!res.ok) throw new Error(`Analysis failed (${res.status})`);
      const data = await res.json();
      if (data.floor_plan) {
        setFloorPlanData(data.floor_plan);
        setMode("result");
      } else {
        setError("No floor plan could be generated from this image.");
      }
    } catch (err) {
      setError(`Floor plan analysis failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setFloorPlanLoading(false);
    }
  }, [floorPlanImage]);

  // ============================================================
  // No-Floor-Plan (Photo Reconstruction) Flow
  // ============================================================

  const handlePhotosSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files || []);
      if (files.length === 0) return;
      setPhotos((prev) => [...prev, ...files]);
      const newPreviews = files.map((f) => URL.createObjectURL(f));
      setPhotoPreviews((prev) => [...prev, ...newPreviews]);
      setError("");
    },
    []
  );

  const removePhoto = useCallback((index: number) => {
    setPhotos((prev) => prev.filter((_, i) => i !== index));
    setPhotoPreviews((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const analyzePhotos = useCallback(async () => {
    if (photos.length < 2) {
      setError("Please upload at least 2 overlapping photos of the building.");
      return;
    }
    setPhotoLoading(true);
    setError("");
    try {
      const formData = new FormData();
      photos.forEach((p) => formData.append("photos", p));

      if (useAdvancedPipeline) {
        // Advanced multi-photo reconstruction
        const res = await fetch(`${API}/api/v1/building/reconstruct`, {
          method: "POST",
          body: formData,
        });
        if (!res.ok) throw new Error(`Reconstruction failed (${res.status})`);
        const data: ReconstructionResult = await res.json();
        if (!data.success) throw new Error(data.error || "Reconstruction failed");
        setMultiResult(data);
        if (data.floor_plan) setFloorPlanData(data.floor_plan);
        setMode("result");
      } else {
        // Photo-based pipeline (YOLO + overlap + spatial mapping)
        const res = await fetch(`${API}/api/v1/building/photo-reconstruction`, {
          method: "POST",
          body: formData,
        });
        if (!res.ok) throw new Error(`Photo analysis failed (${res.status})`);
        const data: PhotoReconResult = await res.json();
        if (!data.success) throw new Error(data.error || "Photo analysis failed");
        setPhotoResult(data);
        if (data.floor_plan) setFloorPlanData(data.floor_plan);
        setMode("result");
      }
    } catch (err) {
      setError(`Building scan failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setPhotoLoading(false);
    }
  }, [photos, useAdvancedPipeline]);

  // ============================================================
  // Occupancy Detection
  // ============================================================

  const analyzeOccupancy = useCallback(async () => {
    if (!occupancyImage) {
      setError("Please select a camera frame first.");
      return;
    }
    setOccupancyLoading(true);
    setError("");
    try {
      const formData = new FormData();
      formData.append("file", occupancyImage);
      formData.append("camera_id", occupancyCamera);
      formData.append("zone_id", occupancyZone);
      formData.append("zone_name", occupancyZoneName);
      formData.append("zone_type", "corridor");
      formData.append("maximum_capacity", String(occupancyCapacity));

      const res = await fetch(`${API}/api/v1/occupancy/analyze`, {
        method: "POST",
        body: formData,
      });
      if (!res.ok) throw new Error(`Occupancy analysis failed (${res.status})`);
      const data = await res.json();
      setOccupancyResult(data);

      // Refresh zone overview
      const zonesRes = await fetch(`${API}/api/v1/occupancy/zones`);
      if (zonesRes.ok) {
        const zonesData = await zonesRes.json();
        setOccupancyZones(zonesData.zones || []);
      }
    } catch (err) {
      setError(`Occupancy detection failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setOccupancyLoading(false);
    }
  }, [occupancyImage, occupancyCamera, occupancyZone, occupancyZoneName, occupancyCapacity]);

  // ============================================================
  // Render
  // ============================================================

  return (
    <main className="min-h-screen bg-slate-50">
      {/* HEADER */}
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-[1400px] items-center justify-between px-8 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-teal-600 text-lg text-white">
              🛡️
            </div>
            <div>
              <h1 className="text-xl font-bold text-slate-800">EVAC-X</h1>
              <p className="text-xs text-slate-500">Building Creation & Occupancy Monitoring</p>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <Link
              href="/"
              className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
            >
              ← Dashboard
            </Link>
            <Link
              href="/reconstruct-3d"
              className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
            >
              🏗️ Reconstruction
            </Link>
            <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-teal-500" />
            <span className="text-sm text-teal-600">LIVE</span>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-[1400px] px-8 py-8">
        {/* Error banner */}
        {error && (
          <div className="mb-6 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
            ⚠️ {error}
          </div>
        )}

        {/* ================================================================
            MODE: CHOICE — Select building creation approach
        ================================================================ */}
        {mode === "choice" && (
          <>
            <h2 className="mb-2 text-2xl font-bold text-slate-800">Create a New Building</h2>
            <p className="mb-8 text-slate-500">
              Choose how you want to define your building for the EVAC-X digital twin.
            </p>

            <div className="mb-12 grid gap-6 md:grid-cols-2">
              {/* Option A: Floor Plan */}
              <button
                onClick={() => setMode("floor-plan")}
                className="group rounded-2xl border-2 border-slate-200 bg-white p-8 text-left transition hover:border-teal-400 hover:shadow-md"
              >
                <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-xl bg-teal-50 text-2xl transition group-hover:bg-teal-100">
                  📐
                </div>
                <h3 className="mb-2 text-lg font-semibold text-slate-800">I Have a Floor Plan</h3>
                <p className="text-sm leading-relaxed text-slate-500">
                  Upload an existing floor plan image. AI computer vision identifies rooms, doors,
                  corridors, stairs, ramps, exits, and people to build the evacuation digital twin.
                </p>
                <div className="mt-4 text-sm font-medium text-teal-600">
                  Upload Floor Plan → AI Analysis → Building Model → Digital Twin
                </div>
              </button>

              {/* Option B: No Floor Plan */}
              <button
                onClick={() => setMode("no-floor-plan")}
                className="group rounded-2xl border-2 border-slate-200 bg-white p-8 text-left transition hover:border-teal-400 hover:shadow-md"
              >
                <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-xl bg-teal-50 text-2xl transition group-hover:bg-teal-100">
                  📷
                </div>
                <h3 className="mb-2 text-lg font-semibold text-slate-800">
                  I Don&apos;t Have a Floor Plan
                </h3>
                <p className="text-sm leading-relaxed text-slate-500">
                  Capture multiple overlapping photographs of the building. The system analyzes spatial
                  relationships between images to generate a navigable building model.
                </p>
                <div className="mt-4 text-sm font-medium text-teal-600">
                  Overlapping Photos → Spatial Analysis → Building Model → Digital Twin
                </div>
              </button>
            </div>

            {/* Occupancy monitoring section */}
            <div className="rounded-2xl border border-slate-200 bg-white p-6">
              <div className="mb-4 flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-teal-50 text-xl">
                  👁️
                </div>
                <div>
                  <h3 className="font-semibold text-slate-800">Live Occupancy Monitoring</h3>
                  <p className="text-xs text-slate-500">
                    Use YOLO-World to detect people and monitor zone occupancy in real time
                  </p>
                </div>
              </div>
              <OccupancyPanel
                zones={occupancyZones}
                result={occupancyResult}
                loading={occupancyLoading}
                camera={occupancyCamera}
                zoneId={occupancyZone}
                zoneName={occupancyZoneName}
                capacity={occupancyCapacity}
                imagePreview={
                  occupancyImage ? URL.createObjectURL(occupancyImage) : null
                }
                onCameraChange={setOccupancyCamera}
                onZoneChange={setOccupancyZone}
                onZoneNameChange={setOccupancyZoneName}
                onCapacityChange={setOccupancyCapacity}
                onImageSelect={(file) => {
                  setOccupancyImage(file);
                  setError("");
                }}
                onAnalyze={analyzeOccupancy}
                inputRef={occupancyInputRef}
              />
            </div>
          </>
        )}

        {/* ================================================================
            MODE: FLOOR PLAN — Upload and analyze
        ================================================================ */}
        {mode === "floor-plan" && (
          <div className="mx-auto max-w-3xl">
            <button
              onClick={() => setMode("choice")}
              className="mb-6 text-sm text-teal-600 hover:text-teal-700"
            >
              ← Back to choices
            </button>
            <h2 className="mb-2 text-2xl font-bold text-slate-800">
              Upload Floor Plan
            </h2>
            <p className="mb-6 text-slate-500">
              Upload a floor plan image. AI will identify architectural elements and generate a
              navigable building model with digital twin.
            </p>

            <div className="rounded-2xl border border-slate-200 bg-white p-6">
              <label
                className="flex cursor-pointer flex-col items-center rounded-xl border-2 border-dashed border-slate-300 p-8 transition hover:border-teal-400 hover:bg-teal-50/30"
              >
                {floorPlanPreview ? (
                  <img
                    src={floorPlanPreview}
                    alt="Floor plan preview"
                    className="mb-4 max-h-64 rounded-lg object-contain"
                  />
                ) : (
                  <div className="mb-4 text-4xl">📐</div>
                )}
                <span className="text-sm font-medium text-slate-700">
                  {floorPlanImage ? floorPlanImage.name : "Click to select floor plan image"}
                </span>
                <span className="mt-1 text-xs text-slate-400">
                  PNG, JPG, or PDF
                </span>
                <input
                  ref={floorPlanInputRef}
                  type="file"
                  accept="image/*"
                  onChange={handleFloorPlanSelect}
                  className="hidden"
                />
              </label>

              <button
                onClick={analyzeFloorPlan}
                disabled={!floorPlanImage || floorPlanLoading}
                className="mt-4 w-full rounded-xl bg-teal-600 px-5 py-3 text-sm font-semibold text-white transition hover:bg-teal-700 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {floorPlanLoading ? "🤖 Analyzing Floor Plan..." : "🤖 Analyze Floor Plan"}
              </button>
            </div>
          </div>
        )}

        {/* ================================================================
            MODE: NO FLOOR PLAN — Photo reconstruction
        ================================================================ */}
        {mode === "no-floor-plan" && (
          <div className="mx-auto max-w-3xl">
            <button
              onClick={() => setMode("choice")}
              className="mb-6 text-sm text-teal-600 hover:text-teal-700"
            >
              ← Back to choices
            </button>
            <h2 className="mb-2 text-2xl font-bold text-slate-800">
              Building Scan — Overlapping Photos
            </h2>
            <p className="mb-6 text-slate-500">
              Capture multiple photos of the building with 40-70% visual overlap between consecutive
              shots. The system uses spatial analysis and feature matching to understand the building
              layout.
            </p>

            <div className="rounded-2xl border border-slate-200 bg-white p-6">
              {/* Pipeline selector */}
              <div className="mb-4 flex items-center gap-4 rounded-lg bg-slate-50 p-3">
                <label className="flex items-center gap-2 text-sm text-slate-700">
                  <input
                    type="checkbox"
                    checked={useAdvancedPipeline}
                    onChange={(e) => setUseAdvancedPipeline(e.target.checked)}
                    className="accent-teal-600"
                  />
                  Use advanced multi-photo reconstruction
                </label>
              </div>
              <p className="mb-4 text-xs text-slate-400">
                {useAdvancedPipeline
                  ? "Advanced: Uses feature extraction, camera pose estimation, and landmark fusion for higher accuracy."
                  : "Standard: Uses YOLO detection, overlap analysis, and spatial mapping for quick building model generation."}
              </p>

              {/* Photo upload area */}
              <label className="flex cursor-pointer flex-col items-center rounded-xl border-2 border-dashed border-slate-300 p-6 transition hover:border-teal-400 hover:bg-teal-50/30">
                <div className="mb-2 text-3xl">📷</div>
                <span className="text-sm font-medium text-slate-700">
                  Click to add photos
                </span>
                <span className="mt-1 text-xs text-slate-400">
                  Minimum 2 overlapping photos required
                </span>
                <input
                  ref={photoInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  onChange={handlePhotosSelect}
                  className="hidden"
                />
              </label>

              {/* Uploaded photos */}
              {photoPreviews.length > 0 && (
                <div className="mt-4">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-sm font-medium text-slate-700">
                      {photos.length} photo{photos.length !== 1 ? "s" : ""} uploaded
                    </span>
                    <button
                      onClick={() => {
                        setPhotos([]);
                        setPhotoPreviews([]);
                      }}
                      className="text-xs text-red-500 hover:text-red-600"
                    >
                      Clear all
                    </button>
                  </div>
                  <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-5">
                    {photoPreviews.map((preview, i) => (
                      <div key={i} className="group relative">
                        <img
                          src={preview}
                          alt={`Photo ${i + 1}`}
                          className="h-24 w-full rounded-lg object-cover border border-slate-200"
                        />
                        <div className="absolute left-1 top-1 rounded bg-teal-600 px-1.5 py-0.5 text-[10px] font-bold text-white">
                          {i + 1}
                        </div>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            removePhoto(i);
                          }}
                          className="absolute right-1 top-1 hidden h-5 w-5 items-center justify-center rounded-full bg-red-500 text-[10px] text-white group-hover:flex"
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <button
                onClick={analyzePhotos}
                disabled={photos.length < 2 || photoLoading}
                className="mt-4 w-full rounded-xl bg-teal-600 px-5 py-3 text-sm font-semibold text-white transition hover:bg-teal-700 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {photoLoading
                  ? "🔄 Processing Building Scan..."
                  : `🏗️ ${useAdvancedPipeline ? "Start Advanced Reconstruction" : "Start Building Scan"}`}
              </button>
            </div>
          </div>
        )}

        {/* ================================================================
            MODE: RESULT — Show generated floor plan + occupancy
        ================================================================ */}
        {mode === "result" && (
          <>
            <div className="mb-6 flex items-center justify-between">
              <div>
                <button
                  onClick={() => {
                    setMode("choice");
                    setFloorPlanData(null);
                    setPhotoResult(null);
                    setMultiResult(null);
                  }}
                  className="mb-2 text-sm text-teal-600 hover:text-teal-700"
                >
                  ← Create another building
                </button>
                <h2 className="text-2xl font-bold text-slate-800">Building Model Generated</h2>
              </div>
            </div>

            {/* Metadata cards */}
            <div className="mb-6 grid gap-4 md:grid-cols-4">
              <StatCard
                icon="📷"
                label="Photos Processed"
                value={String(
                  multiResult?.reconstruction?.photos_received ??
                    photoResult?.analysis?.photos_processed ??
                    1
                )}
              />
              <StatCard
                icon="🔍"
                label="Detections"
                value={String(
                  multiResult?.detections?.fused_landmarks?.length ??
                    photoResult?.analysis?.detections ??
                    0
                )}
              />
              <StatCard
                icon="🔗"
                label="Overlap Relationships"
                value={String(photoResult?.analysis?.overlap_relationships ?? 0)}
              />
              <StatCard
                icon="🧠"
                label="Confidence"
                value={`${Math.round(
                  ((multiResult?.metadata?.overall_confidence ??
                    photoResult?.metadata?.overall_confidence ??
                    0) *
                    100)
                )}%`}
              />
            </div>

            {/* Warning */}
            {(multiResult?.metadata?.warning || photoResult?.metadata?.warning) && (
              <div className="mb-6 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-700">
                ⚠️{" "}
                {multiResult?.metadata?.warning || photoResult?.metadata?.warning}
              </div>
            )}

            {/* Generated floor plan visualization */}
            {floorPlanData && floorPlanData.elements.length > 0 && (
              <div className="mb-6 rounded-2xl border border-slate-200 bg-white p-6">
                <h3 className="mb-4 font-semibold text-slate-800">Generated Floor Plan</h3>
                <div className="relative mx-auto overflow-hidden rounded-xl border border-slate-200 bg-slate-50" style={{ maxWidth: 900, height: 500 }}>
                  {/* Grid */}
                  <div
                    className="absolute inset-0 opacity-30"
                    style={{
                      backgroundImage:
                        "linear-gradient(rgba(0,0,0,0.04) 1px, transparent 1px), linear-gradient(90deg, rgba(0,0,0,0.04) 1px, transparent 1px)",
                      backgroundSize: "40px 40px",
                    }}
                  />
                  {floorPlanData.elements.map((el) => {
                    const scaleX = 860 / (floorPlanData.width || 1000);
                    const scaleY = 460 / (floorPlanData.height || 600);
                    const scale = Math.min(scaleX, scaleY);
                    const offsetX = 20;
                    const offsetY = 20;
                    const left = offsetX + el.x * scale;
                    const top = offsetY + el.y * scale;
                    const w = Math.max(el.width * scale, 4);
                    const h = Math.max(el.height * scale, 4);
                    const colors = ELEMENT_COLORS[el.type] || ELEMENT_COLORS.room;

                    return (
                      <div
                        key={el.id}
                        className={`absolute rounded border ${colors.bg} ${colors.border}`}
                        style={{ left, top, width: w, height: h }}
                        title={`${el.type}: ${el.id}`}
                      >
                        {w > 40 && h > 14 && (
                          <span className={`flex h-full items-center justify-center text-[9px] font-medium ${colors.text}`}>
                            {el.type.toUpperCase()}
                          </span>
                        )}
                      </div>
                    );
                  })}
                  {/* Legend */}
                  <div className="absolute bottom-3 left-3 rounded-lg border border-slate-200 bg-white/95 p-3 backdrop-blur">
                    <p className="mb-2 text-[10px] font-semibold text-slate-500">LEGEND</p>
                    <div className="space-y-1 text-[10px]">
                      {Object.entries(ELEMENT_COLORS).map(([type, colors]) => (
                        <div key={type} className="flex items-center gap-2">
                          <span className={`h-2 w-2 rounded ${colors.bg} border ${colors.border}`} />
                          <span className="text-slate-500 capitalize">{type}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Navigation graph info */}
            {photoResult?.navigation_graph && (
              <div className="mb-6 rounded-2xl border border-slate-200 bg-white p-6">
                <h3 className="mb-4 font-semibold text-slate-800">Navigation Graph</h3>
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="rounded-lg bg-slate-50 p-4">
                    <p className="text-xs text-slate-500">Nodes</p>
                    <p className="text-2xl font-bold text-slate-800">
                      {photoResult.navigation_graph.nodes.length}
                    </p>
                  </div>
                  <div className="rounded-lg bg-slate-50 p-4">
                    <p className="text-xs text-slate-500">Edges</p>
                    <p className="text-2xl font-bold text-slate-800">
                      {photoResult.navigation_graph.edges.length}
                    </p>
                  </div>
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  {photoResult.navigation_graph.nodes.map((n) => (
                    <span
                      key={n.id}
                      className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs text-slate-600"
                    >
                      {n.label || n.type}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Quick actions */}
            <div className="flex flex-wrap gap-3">
              <Link
                href="/reconstruct-3d"
                className="rounded-xl bg-teal-600 px-5 py-3 text-sm font-semibold text-white transition hover:bg-teal-700"
              >
                🏗️ Open Full Reconstruction & Evacuation
              </Link>
              <Link
                href="/reconstruct"
                className="rounded-xl border border-slate-200 bg-white px-5 py-3 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
              >
                📐 Single-Photo Floor Plan
              </Link>
              <button
                onClick={() => {
                  setMode("choice");
                  setFloorPlanData(null);
                  setPhotoResult(null);
                  setMultiResult(null);
                }}
                className="rounded-xl border border-slate-200 bg-white px-5 py-3 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
              >
                + Create Another Building
              </button>
            </div>
          </>
        )}
      </div>
    </main>
  );
}

// ============================================================
// Sub-components
// ============================================================

function StatCard({
  icon,
  label,
  value,
}: {
  icon: string;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-lg">{icon}</span>
        <span className="text-[10px] font-medium text-slate-400">LIVE</span>
      </div>
      <p className="text-xs text-slate-500">{label}</p>
      <p className="mt-1 text-xl font-bold text-slate-800">{value}</p>
    </div>
  );
}

function OccupancyPanel({
  zones,
  result,
  loading,
  camera,
  zoneId,
  zoneName,
  capacity,
  imagePreview,
  onCameraChange,
  onZoneChange,
  onZoneNameChange,
  onCapacityChange,
  onImageSelect,
  onAnalyze,
  inputRef,
}: {
  zones: OccupancyZone[];
  result: any;
  loading: boolean;
  camera: string;
  zoneId: string;
  zoneName: string;
  capacity: number;
  imagePreview: string | null;
  onCameraChange: (v: string) => void;
  onZoneChange: (v: string) => void;
  onZoneNameChange: (v: string) => void;
  onCapacityChange: (v: number) => void;
  onImageSelect: (file: File) => void;
  onAnalyze: () => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
}) {
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_1fr]">
      {/* Left: Upload + settings */}
      <div>
        <label className="mb-3 block cursor-pointer rounded-xl border-2 border-dashed border-slate-300 p-6 text-center transition hover:border-teal-400 hover:bg-teal-50/30">
          {imagePreview ? (
            <img
              src={imagePreview}
              alt="Camera frame"
              className="mx-auto mb-2 max-h-40 rounded-lg object-contain"
            />
          ) : (
            <div className="text-3xl">📷</div>
          )}
          <span className="text-sm text-slate-600">
            Select a camera frame or image
          </span>
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) onImageSelect(file);
            }}
            className="hidden"
          />
        </label>

        <div className="mt-4 space-y-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600">Camera ID</label>
            <input
              type="text"
              value={camera}
              onChange={(e) => onCameraChange(e.target.value)}
              className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 focus:border-teal-500 focus:ring-teal-500 focus:outline-none focus:ring-1"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">Zone ID</label>
              <input
                type="text"
                value={zoneId}
                onChange={(e) => onZoneChange(e.target.value)}
                className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 focus:border-teal-500 focus:ring-teal-500 focus:outline-none focus:ring-1"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">Zone Name</label>
              <input
                type="text"
                value={zoneName}
                onChange={(e) => onZoneNameChange(e.target.value)}
                className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 focus:border-teal-500 focus:ring-teal-500 focus:outline-none focus:ring-1"
              />
            </div>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600">Max Capacity</label>
            <input
              type="number"
              value={capacity}
              onChange={(e) => onCapacityChange(Number(e.target.value))}
              min={1}
              className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 focus:border-teal-500 focus:ring-teal-500 focus:outline-none focus:ring-1"
            />
          </div>
        </div>

        <button
          onClick={onAnalyze}
          disabled={loading}
          className="mt-4 w-full rounded-xl bg-teal-600 px-4 py-3 text-sm font-semibold text-white transition hover:bg-teal-700 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {loading ? "🔍 Detecting People..." : "🔍 Detect People (YOLO-World)"}
        </button>
      </div>

      {/* Right: Results */}
      <div>
        {result ? (
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
            <h4 className="mb-3 font-semibold text-slate-800">Detection Results</h4>
            <div className="mb-3 grid grid-cols-2 gap-3">
              <div className="rounded-lg bg-white p-3 border border-slate-200">
                <p className="text-xs text-slate-500">People Detected</p>
                <p className="text-2xl font-bold text-teal-600">{result.person_count}</p>
              </div>
              <div className="rounded-lg bg-white p-3 border border-slate-200">
                <p className="text-xs text-slate-500">Status</p>
                <CongestionBadge status={result.occupancy?.congestion_status || "NORMAL"} />
              </div>
            </div>
            {result.occupancy && (
              <div className="rounded-lg bg-white p-3 border border-slate-200">
                <div className="flex items-center justify-between text-xs text-slate-500">
                  <span>Occupancy</span>
                  <span>
                    {result.occupancy.current_people} / {result.occupancy.maximum_capacity}
                  </span>
                </div>
                <div className="mt-1 h-2 overflow-hidden rounded-full bg-slate-200">
                  <div
                    className="h-full rounded-full bg-teal-500 transition-all"
                    style={{
                      width: `${Math.min(result.occupancy.occupancy_ratio * 100, 100)}%`,
                    }}
                  />
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="flex h-full items-center justify-center rounded-xl border border-dashed border-slate-300 p-8 text-center">
            <div>
              <div className="mb-2 text-3xl">👁️</div>
              <p className="text-sm text-slate-500">
                Upload a camera frame and click Detect to see occupancy results
              </p>
            </div>
          </div>
        )}

        {/* Zone overview */}
        {zones.length > 0 && (
          <div className="mt-4">
            <h4 className="mb-2 text-sm font-semibold text-slate-700">All Monitored Zones</h4>
            <div className="space-y-2">
              {zones.map((z) => (
                <div
                  key={z.zone_id}
                  className="flex items-center justify-between rounded-lg border border-slate-200 bg-white px-3 py-2"
                >
                  <div>
                    <span className="text-sm font-medium text-slate-800">{z.zone_name}</span>
                    <span className="ml-2 text-xs text-slate-400">
                      {z.current_people}/{z.maximum_capacity}
                    </span>
                  </div>
                  <CongestionBadge status={z.congestion_status} />
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function CongestionBadge({ status }: { status: string }) {
  const colors = CONGESTION_COLORS[status] || CONGESTION_COLORS.NORMAL;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${colors.bg} ${colors.text}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${colors.dot}`} />
      {status.replace("_", " ")}
    </span>
  );
}
