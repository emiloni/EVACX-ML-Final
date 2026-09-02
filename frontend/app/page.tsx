"use client";

import {
  useEffect,
  useState,
  type ChangeEvent,
} from "react";
import Link from "next/link";

type Mobility =
  | "normal"
  | "wheelchair"
  | "elderly"
  | "temporary_injury";

type RouteData = {
  success: boolean;
  route: string[];
  recommended_exit: string;
  cost: number;
  risk: string;
  mobility: string;
};

type DemoResponse = {
  success: boolean;
  scenario: string;
  mobility: string;
  hazard?: {
    type: string;
    location: string;
    severity: string;
  };
  route: RouteData;
};

const API =
  process.env.NEXT_PUBLIC_BACKEND_HTTP ||
  "http://127.0.0.1:8000";

export default function Home() {
  const [mobility, setMobility] =
    useState<Mobility>("normal");

  const [scenario, setScenario] =
    useState<"normal" | "fire">("normal");

  const [route, setRoute] =
    useState<RouteData | null>(null);

  const [loading, setLoading] =
    useState(false);

  const [error, setError] =
    useState("");

  const [selectedFile, setSelectedFile] =
  useState<File | null>(null);

const [previewUrl, setPreviewUrl] =
  useState<string | null>(null);

const [scanning, setScanning] =
  useState(false);

const [environment, setEnvironment] =
  useState({
    people: 8,
    exits: 3,
    hazards: 0,
    detections: 0,
  });

const [floorPlan, setFloorPlan] = useState<{
  width: number;
  height: number;
  units: string;
  approximate: boolean;
  elements: Array<{
    id: string;
    type: string;
    x: number;
    y: number;
    width: number;
    height: number;
    confidence?: number;
    wheelchair_accessible?: boolean;
    estimated?: boolean;
    connected_door_id?: string;
  }>;
} | null>(null);
async function analyzeBuilding() {
  if (!selectedFile) {
    setError("Please select a building image first.");
    return;
  }

  setScanning(true);
  setError("");

  try {
    const formData = new FormData();

    formData.append(
      "file",
      selectedFile
    );

    const response = await fetch(
      `/api/analyze?mobility=${mobility}`,
      {
        method: "POST",
        body: formData,
      }
    );

   if (!response.ok) {
  const errorText = await response.text();

  console.error(
    "BACKEND ERROR:",
    errorText
  );

  throw new Error(
    `AI analysis failed (${response.status}): ${errorText}`
  );
} if (!response.ok) {
      throw new Error(
        `AI analysis failed: ${response.status}`
      );
    }

    const data = await response.json();

    console.log(
      "AI ENVIRONMENT:",
      data
    );

    if (data.environment) {
      setEnvironment({
        people:
          data.environment.people ?? 0,

        exits:
          data.environment.exits ?? 0,

        hazards:
          data.environment.hazards ?? 0,

        detections:
          data.environment.detections ?? 0,
      });
    }

    if (data.floor_plan) {
      console.log("FLOOR PLAN elements:", data.floor_plan.elements?.length);
      setFloorPlan(data.floor_plan);
    }

    if (data.route) {
      setRoute(data.route);
    }

  } catch (err) {

    console.error(err);

    setError(
      "AI analysis failed. Make sure the FastAPI server is running."
    );

  } finally {

    setScanning(false);

  }
}

function handleImageSelect(
  event: ChangeEvent<HTMLInputElement>
) {
  const file =
    event.target.files?.[0];

  if (!file) return;

  setSelectedFile(file);

  const url =
    URL.createObjectURL(file);

  setPreviewUrl(url);

  setError("");
}
  async function calculateRoute(
    selectedMobility: Mobility = mobility,
    selectedScenario:
      | "normal"
      | "fire" = scenario
  ) {
    setLoading(true);
    setError("");

    try {
      const endpoint =
        selectedScenario === "fire"
          ? "/api/demo/fire"
          : "/api/demo/route";

      const response = await fetch(
        `${API}${endpoint}?mobility=${selectedMobility}`,
        {
          method: "POST",
        }
      );

      if (!response.ok) {
        throw new Error(
          `Backend returned ${response.status}`
        );
      }

      const data: DemoResponse =
        await response.json();

      setRoute(data.route);
    } catch (err) {
      console.error(err);

      setError(
        "Unable to connect to the evacuation engine."
      );
    } finally {
      setLoading(false);
    }
  }

  function handleMobilityChange(
    value: Mobility
  ) {
    setMobility(value);

    calculateRoute(
      value,
      scenario
    );
  }

  function simulateFire() {
    setScenario("fire");

    calculateRoute(
      mobility,
      "fire"
    );
  }

  function resetScenario() {
    setScenario("normal");

    calculateRoute(
      mobility,
      "normal"
    );
  }

  return (
    <main className="min-h-screen bg-[#07111f] text-white">

      {/* HEADER */}

      <header className="border-b border-white/10 bg-[#091525]">

        <div className="mx-auto flex max-w-[1500px] items-center justify-between px-8 py-5">

          <div>
            <div className="flex items-center gap-3">

              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-500 text-xl">
                🛡️
              </div>

              <div>
                <h1 className="text-xl font-bold">
                  AI Evacuation Twin
                </h1>

                <p className="text-xs text-slate-400">
                  Floor-Plan-Free Emergency Navigation
                </p>
              </div>

              <Link
                href="/buildings/new"
                className="rounded-lg border border-teal-500/30 bg-teal-500/10 px-4 py-2 text-xs font-medium text-teal-300 transition hover:bg-teal-500/20"
              >
                🏢 Create Building
              </Link>
              <Link
                href="/reconstruct"
                className="rounded-lg border border-purple-500/30 bg-purple-500/10 px-4 py-2 text-xs font-medium text-purple-300 transition hover:bg-purple-500/20"
              >
                📷 Single Photo
              </Link>
              <Link
                href="/reconstruct-3d"
                className="rounded-lg border border-blue-500/30 bg-blue-500/10 px-4 py-2 text-xs font-medium text-blue-300 transition hover:bg-blue-500/20"
              >
                🏗️ Multi-Photo Reconstruct
              </Link>

            </div>
          </div>

          <div className="flex items-center gap-3">

            <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-emerald-400" />

            <span className="text-sm text-emerald-300">
              SYSTEM LIVE
            </span>

          </div>

        </div>

      </header>

      {/* CONTENT */}

      <div className="mx-auto max-w-[1500px] px-8 py-8">
{/* AI SCANNER */}

<section className="mb-6 rounded-2xl border border-white/10 bg-[#0b1829] p-6">

  <div className="flex flex-col gap-5 md:flex-row md:items-center md:justify-between">

    <div>

      <div className="flex items-center gap-3">

        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-purple-500/10 text-xl">
          🤖
        </div>

        <div>

          <h2 className="font-semibold">
            AI Environment Scanner
          </h2>

          <p className="text-xs text-slate-400">
            No floor plan required
          </p>

        </div>

      </div>

      <p className="mt-3 max-w-xl text-sm leading-relaxed text-slate-400">
        Upload an ordinary building image. Computer vision
        identifies people, exits and hazards to initialize
        the evacuation digital twin.
      </p>

    </div>

    <div className="flex items-center gap-3">

      <label className="cursor-pointer rounded-xl border border-white/10 bg-[#07111f] px-5 py-3 text-sm font-medium transition hover:border-purple-400">

        📷 Choose Image

        <input
          type="file"
          accept="image/*"
          onChange={handleImageSelect}
          className="hidden"
        />

      </label>

      <button
        onClick={analyzeBuilding}
        disabled={
          !selectedFile ||
          scanning
        }
        className="rounded-xl bg-purple-500 px-5 py-3 text-sm font-semibold transition hover:bg-purple-400 disabled:cursor-not-allowed disabled:opacity-40"
      >

        {scanning
          ? "🤖 Analyzing..."
          : "✨ Analyze Building"}

      </button>

    </div>

  </div>

  {selectedFile && (

    <div className="mt-5 flex items-center gap-4 rounded-xl border border-white/10 bg-[#07111f] p-3">

      {previewUrl && (

        <img
          src={previewUrl}
          alt="Building preview"
          className="h-20 w-28 rounded-lg object-cover"
        />

      )}

      <div>

        <p className="text-sm font-medium">
          {selectedFile.name}
        </p>

        <p className="mt-1 text-xs text-slate-500">
          Ready for AI environment analysis
        </p>

      </div>

    </div>

  )}

</section>
        {/* TOP CARDS */}

        <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4">

          <StatCard
            icon="👥"
            label="Occupancy"
            value={String(environment.people)}
            sub="people detected"
          />

          <StatCard
            icon="🚪"
            label="Exit Candidates"
            value={String(environment.exits)}
            sub="AI detected"
          />

          <StatCard
              icon="🔥"
              label="Active Hazards"
              value={String(environment.hazards)}
              sub={
                environment.hazards > 0
                  ? "hazard detected"
                  : "environment clear"
              }
            />

          <StatCard
            icon="🧠"
            label="AI Confidence"
            value="87%"
            sub="environment analysis"
          />

        </div>

        {/* MAIN GRID */}

        <div className="grid gap-6 lg:grid-cols-[1fr_390px]">

          {/* DIGITAL TWIN */}

          <section className="overflow-hidden rounded-2xl border border-white/10 bg-[#0b1829]">

            <div className="flex items-center justify-between border-b border-white/10 px-6 py-4">

              <div>
                <h2 className="font-semibold">
                  Digital Twin
                </h2>

                <p className="text-xs text-slate-400">
  Generated from visual environment analysis • No floor plan
</p>
              </div>

              <div className="rounded-lg bg-emerald-500/10 px-3 py-1.5 text-xs text-emerald-300">
                LIVE GRAPH
              </div>

            </div>

            <div className="relative min-h-[620px] overflow-hidden bg-[#081321]">

              {/* GRID */}

              <div
                className="absolute inset-0 opacity-20"
                style={{
                  backgroundImage:
                    "linear-gradient(rgba(255,255,255,.08) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.08) 1px, transparent 1px)",
                  backgroundSize: "40px 40px",
                }}
              />

              {/* CORRIDOR */}

              <div className="absolute left-[20%] right-[20%] top-[42%] h-24 rounded-2xl border border-slate-500/40 bg-slate-800/70">

                <div className="flex h-full items-center justify-center">

                  <span className="text-xs font-semibold tracking-[0.25em] text-slate-400">
                    MAIN CORRIDOR
                  </span>

                </div>

              </div>

              {/* ROUTE LINES */}

              {scenario === "normal" &&
                mobility === "normal" && (
                  <>
                    <RouteLine
                      className="left-[34%] top-[38%] h-[16%] rotate-[20deg]"
                    />

                    <RouteLine
                      className="left-[28%] top-[27%] w-[14%] rotate-[-15deg]"
                      horizontal
                    />
                  </>
                )}

              {mobility === "wheelchair" && (
                <>
                  <RouteLine
                    className="left-[45%] top-[50%] w-[20%] rotate-[20deg]"
                    horizontal
                  />

                  <RouteLine
                    className="left-[63%] top-[38%] h-[15%] rotate-[-25deg]"
                  />
                </>
              )}

              {scenario === "fire" &&
                mobility !== "wheelchair" && (
                  <>
                    <RouteLine
                      className="left-[45%] top-[43%] w-[24%] rotate-[-10deg]"
                      horizontal
                    />
                  </>
                )}

              {/* YOU */}

              <MapNode
                className="left-[28%] top-[48%]"
                label="YOU"
                icon="●"
                active
              />

              {/* STAIRS */}

              <MapNode
                className="left-[28%] top-[27%]"
                label="STAIRS"
                icon="▥"
                disabled={
                  mobility === "wheelchair"
                }
              />

              {/* RAMP */}

              <MapNode
                className="left-[54%] top-[61%]"
                label="RAMP"
                icon="♿"
              />

              {/* EXIT A */}

              <MapNode
                className="left-[16%] top-[17%]"
                label="EXIT A"
                icon="↗"
                disabled={
                  scenario === "fire"
                }
              />

              {/* EXIT B */}

              <MapNode
                className="left-[59%] top-[17%]"
                label="EXIT B"
                icon="↗"
                selected={
                  route?.recommended_exit ===
                  "EXIT B"
                }
              />

              {/* EXIT C */}

              <MapNode
                className="right-[13%] top-[40%]"
                label="EXIT C"
                icon="↗"
                selected={
                  route?.recommended_exit ===
                  "EXIT C"
                }
              />

              {/* FIRE */}

              {scenario === "fire" && (
                <div className="absolute left-[23%] top-[31%] flex h-14 w-14 animate-pulse items-center justify-center rounded-full border-2 border-red-500 bg-red-500/20 text-2xl shadow-lg shadow-red-500/30">
                  🔥
                </div>
              )}

              {/* LEGEND */}

              <div className="absolute bottom-5 left-5 rounded-xl border border-white/10 bg-[#0b1829]/90 p-4 backdrop-blur">

                <p className="mb-3 text-xs font-semibold text-slate-400">
                  LEGEND
                </p>

                <div className="space-y-2 text-xs">

                  <Legend
                    dot="bg-emerald-400"
                    text="Recommended route"
                  />

                  <Legend
                    dot="bg-red-500"
                    text="Hazard / blocked"
                  />

                  <Legend
                    dot="bg-slate-500"
                    text="Navigation node"
                  />

                </div>

              </div>

            </div>

          </section>

          {/* CONTROL PANEL */}

          <aside className="space-y-6">

            {/* ROUTE RESULT */}

            <section className="rounded-2xl border border-white/10 bg-[#0b1829] p-6">

              <div className="mb-5">

                <p className="text-xs font-semibold uppercase tracking-widest text-slate-500">
                  Recommended Evacuation
                </p>

                <h2 className="mt-2 text-3xl font-bold">
                  {route?.recommended_exit ||
                    "Calculating..."}
                </h2>

              </div>

              {route && (
                <>

                  <div className="mb-5 grid grid-cols-2 gap-3">

                    <InfoBox
                      label="Risk"
                      value={route.risk}
                    />

                    <InfoBox
                      label="Confidence"
                      value={
                        route.risk === "LOW"
                          ? "HIGH"
                          : "MEDIUM"
                      }
                    />

                  </div>

                  <div className="rounded-xl bg-[#07111f] p-4">

                    <p className="mb-3 text-xs text-slate-500">
                      ROUTE
                    </p>

                    <div className="space-y-2">

                      {route.route.map(
                        (node, index) => (
                          <div
                            key={`${node}-${index}`}
                            className="flex items-center gap-3"
                          >

                            <div className="flex h-7 w-7 items-center justify-center rounded-full bg-emerald-500/10 text-xs text-emerald-300">
                              {index + 1}
                            </div>

                            <span className="text-sm">
                              {formatNode(node)}
                            </span>

                          </div>
                        )
                      )}

                    </div>

                  </div>

                </>
              )}

            </section>

            {/* MOBILITY */}

            <section className="rounded-2xl border border-white/10 bg-[#0b1829] p-6">

              <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-slate-500">
                Mobility Profile
              </p>

              <select
                value={mobility}
                onChange={(e) =>
                  handleMobilityChange(
                    e.target.value as Mobility
                  )
                }
                className="w-full rounded-xl border border-white/10 bg-[#07111f] px-4 py-3 text-sm outline-none focus:border-emerald-400"
              >

                <option value="normal">
                  Normal
                </option>

                <option value="wheelchair">
                  ♿ Wheelchair
                </option>

                <option value="elderly">
                  👴 Elderly
                </option>

                <option value="temporary_injury">
                  🩼 Temporary Injury
                </option>

              </select>

            </section>

            {/* HAZARD CONTROL */}

            <section className="rounded-2xl border border-white/10 bg-[#0b1829] p-6">

              <p className="mb-4 text-xs font-semibold uppercase tracking-widest text-slate-500">
                Emergency Simulation
              </p>

              {scenario === "normal" ? (

                <button
                  onClick={simulateFire}
                  disabled={loading}
                  className="w-full rounded-xl bg-red-500 px-4 py-3 font-semibold transition hover:bg-red-400 disabled:opacity-50"
                >
                  {loading
                    ? "Recalculating..."
                    : "🔥 Simulate Fire"}
                </button>

              ) : (

                <button
                  onClick={resetScenario}
                  disabled={loading}
                  className="w-full rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-4 py-3 font-semibold text-emerald-300 transition hover:bg-emerald-500/20"
                >
                  ↻ Reset Emergency
                </button>

              )}

              {scenario === "fire" && (
                <div className="mt-4 rounded-xl border border-red-500/20 bg-red-500/10 p-4">

                  <div className="flex gap-3">

                    <span className="text-xl">
                      🔥
                    </span>

                    <div>

                      <p className="font-semibold text-red-300">
                        Fire Detected
                      </p>

                      <p className="mt-1 text-xs text-red-200/70">
                        Exit A / stairs route
                        unavailable
                      </p>

                    </div>

                  </div>

                </div>
              )}

            </section>

            {/* ADVISORY */}

            <div className="rounded-xl border border-yellow-500/20 bg-yellow-500/5 p-4 text-xs leading-relaxed text-yellow-200/70">

              <strong className="text-yellow-300">
                Advisory system:
              </strong>{" "}
              Follow on-site emergency instructions
              and emergency personnel. Route
              recommendations depend on available
              environmental information.

            </div>

            {error && (
              <div className="rounded-xl border border-red-500/20 bg-red-500/10 p-4 text-sm text-red-300">
                {error}
              </div>
            )}

          </aside>

        </div>

        {/* GENERATED FLOOR PLAN */}

        {floorPlan && (
          <section className="mt-6 overflow-hidden rounded-2xl border border-white/10 bg-[#0b1829]">

            <div className="flex items-center justify-between border-b border-white/10 px-6 py-4">

              <div>

                <h2 className="font-semibold">
                  Generated Floor Plan
                </h2>

                <p className="text-xs text-slate-400">
                  AI-generated approximate layout ({floorPlan.elements.length} elements)
                </p>

              </div>

              <div className="rounded-lg bg-purple-500/10 px-3 py-1.5 text-xs text-purple-300">
                APPROXIMATE
              </div>

            </div>

            <div className="relative min-h-[500px] overflow-hidden bg-[#081321]">

              <div
                className="absolute inset-0 opacity-20"
                style={{
                  backgroundImage:
                    "linear-gradient(rgba(255,255,255,.08) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.08) 1px, transparent 1px)",
                  backgroundSize: "40px 40px",
                }}
              />

              {floorPlan.elements.map((el) => {
                const scaleX = 750 / floorPlan.width;
                const scaleY = 450 / floorPlan.height;
                const scale = Math.min(scaleX, scaleY);
                const offsetX = 30;
                const offsetY = 25;
                const left = offsetX + el.x * scale;
                const top = offsetY + el.y * scale;
                const w = Math.max(el.width * scale, 6);
                const h = Math.max(el.height * scale, 6);

                const colorMap: Record<string, string> = {
                  corridor: "bg-slate-700/60 border-slate-500/40",
                  door: "bg-blue-500/40 border-blue-400/60",
                  room: "bg-purple-500/15 border-purple-400/30",
                  stairs: "bg-yellow-500/25 border-yellow-400/50",
                  ramp: "bg-emerald-500/25 border-emerald-400/50",
                  elevator: "bg-emerald-500/25 border-emerald-400/50",
                  exit: "bg-red-500/30 border-red-400/50",
                };
                const colorClass = colorMap[el.type] || "bg-slate-600/30 border-slate-400/30";

                return (
                  <div
                    key={el.id}
                    className={`absolute rounded border ${colorClass}`}
                    style={{
                      left: left + "px",
                      top: top + "px",
                      width: w + "px",
                      height: h + "px",
                    }}
                    title={`${el.type}: ${el.id}`}
                  >
                    {w > 50 && h > 18 && (
                      <span className="flex h-full items-center justify-center text-[9px] font-medium text-white/70">
                        {el.type.toUpperCase()}
                      </span>
                    )}
                  </div>
                );
              })}

              <div className="absolute bottom-4 left-4 rounded-xl border border-white/10 bg-[#0b1829]/90 p-3 backdrop-blur">
                <p className="mb-2 text-[10px] font-semibold text-slate-400">LEGEND</p>
                <div className="space-y-1 text-[10px]">
                  <LegendRow color="bg-slate-600" text="Corridor" />
                  <LegendRow color="bg-blue-400" text="Door" />
                  <LegendRow color="bg-purple-400" text="Room" />
                  <LegendRow color="bg-yellow-400" text="Stairs" />
                  <LegendRow color="bg-emerald-400" text="Ramp / Elevator" />
                  <LegendRow color="bg-red-400" text="Exit" />
                </div>
              </div>

            </div>

          </section>
        )}

      </div>

    </main>
  );
}


/* ----------------------------------------- */
/* COMPONENTS */
/* ----------------------------------------- */

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

        <span className="text-xl">
          {icon}
        </span>

        <span className="text-xs text-slate-500">
          LIVE
        </span>

      </div>

      <p className="text-xs text-slate-400">
        {label}
      </p>

      <p className="mt-1 text-2xl font-bold">
        {value}
      </p>

      <p className="mt-1 text-xs text-slate-500">
        {sub}
      </p>

    </div>
  );
}


function InfoBox({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-xl bg-[#07111f] p-3">

      <p className="text-[10px] uppercase text-slate-500">
        {label}
      </p>

      <p className="mt-1 font-semibold text-emerald-300">
        {value}
      </p>

    </div>
  );
}


function MapNode({
  className,
  label,
  icon,
  active = false,
  disabled = false,
  selected = false,
}: {
  className: string;
  label: string;
  icon: string;
  active?: boolean;
  disabled?: boolean;
  selected?: boolean;
}) {
  return (
    <div
      className={`absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center ${className}`}
    >

      <div
        className={`
          flex h-12 w-12 items-center justify-center rounded-full
          border-2 text-lg
          ${
            disabled
              ? "border-red-500/60 bg-red-500/10 text-red-400"
              : selected
              ? "border-emerald-400 bg-emerald-400/20 text-emerald-300 shadow-lg shadow-emerald-400/20"
              : active
              ? "border-white bg-white/10 text-white"
              : "border-slate-600 bg-slate-800 text-slate-300"
          }
        `}
      >
        {icon}
      </div>

      <span
        className={`mt-2 whitespace-nowrap text-[10px] font-semibold tracking-wider ${
          disabled
            ? "text-red-400"
            : selected
            ? "text-emerald-300"
            : "text-slate-400"
        }`}
      >
        {disabled
          ? `${label} BLOCKED`
          : label}
      </span>

    </div>
  );
}


function RouteLine({
  className,
  horizontal = false,
}: {
  className: string;
  horizontal?: boolean;
}) {
  return (
    <div
      className={`absolute ${
        horizontal
          ? "h-1"
          : "w-1"
      } origin-left rounded-full bg-emerald-400 shadow-lg shadow-emerald-400/40 ${className}`}
    />
  );
}


function Legend({
  dot,
  text,
}: {
  dot: string;
  text: string;
}) {
  return (
    <div className="flex items-center gap-2">

      <span
        className={`h-2 w-2 rounded-full ${dot}`}
      />

      <span className="text-slate-400">
        {text}
      </span>

    </div>
  );
}


function formatNode(node: string) {

  const names: Record<string, string> = {
    start: "YOU ARE HERE",
    stairs: "STAIRS",
    corridor: "MAIN CORRIDOR",
    ramp: "ACCESSIBLE RAMP",
    exit_a: "EXIT A",
    exit_b: "EXIT B",
    exit_c: "EXIT C",
  };

  return (
    names[node] ||
    node.replaceAll("_", " ").toUpperCase()
  );
}


function LegendRow({
  color,
  text,
}: {
  color: string;
  text: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className={`h-2 w-2 rounded-full ${color}`} />
      <span className="text-slate-400">{text}</span>
    </div>
  );
}