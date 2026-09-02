"use client";

/* ============================================================
   SimulationControls
   ============================================================
   Provides Start / Pause / Reset controls for the evacuation
   animation, plus a recalculate button when the floor plan
   has changed.
   ============================================================ */

export type SimState = "idle" | "running" | "paused";

interface SimulationControlsProps {
  state: SimState;
  onStart: () => void;
  onPause: () => void;
  onResume: () => void;
  onReset: () => void;
  onRecalculate?: () => void;
  needsRecalculation?: boolean;
  hasRoutes: boolean;
  hasFire: boolean;
  hasOccupants: boolean;
  className?: string;
}

export default function SimulationControls({
  state,
  onStart,
  onPause,
  onResume,
  onReset,
  onRecalculate,
  needsRecalculation = false,
  hasRoutes,
  hasFire,
  hasOccupants,
  className = "",
}: SimulationControlsProps) {
  const canStart = hasFire && hasOccupants && hasRoutes && !needsRecalculation;
  const isRunning = state === "running";
  const isPaused = state === "paused";

  return (
    <div className={`flex items-center gap-2 flex-wrap ${className}`}>
      {/* Play / Pause */}
      {!isRunning && !isPaused && (
        <button
          onClick={onStart}
          disabled={!canStart}
          className="flex items-center gap-1.5 rounded-lg bg-teal-600 px-4 py-2 text-xs font-semibold text-white transition hover:bg-teal-700 disabled:opacity-40 disabled:cursor-not-allowed shadow-sm"
        >
          ▶ Start Evacuation
        </button>
      )}

      {isRunning && (
        <button
          onClick={onPause}
          className="flex items-center gap-1.5 rounded-lg bg-amber-500 px-4 py-2 text-xs font-semibold text-white transition hover:bg-amber-600 shadow-sm"
        >
          ⏸ Pause
        </button>
      )}

      {isPaused && (
        <button
          onClick={onResume}
          className="flex items-center gap-1.5 rounded-lg bg-teal-600 px-4 py-2 text-xs font-semibold text-white transition hover:bg-teal-700 shadow-sm"
        >
          ▶ Resume
        </button>
      )}

      {/* Reset */}
      {(isRunning || isPaused) && (
        <button
          onClick={onReset}
          className="flex items-center gap-1.5 rounded-lg bg-slate-100 border border-slate-200 px-4 py-2 text-xs font-medium text-slate-700 transition hover:bg-slate-200"
        >
          ↺ Reset
        </button>
      )}

      {/* Recalculate */}
      {needsRecalculation && onRecalculate && (
        <button
          onClick={onRecalculate}
          className="flex items-center gap-1.5 rounded-lg bg-amber-50 border border-amber-200 px-4 py-2 text-xs font-medium text-amber-700 transition hover:bg-amber-100"
        >
          ⚠ Recalculate Routes
        </button>
      )}
    </div>
  );
}
