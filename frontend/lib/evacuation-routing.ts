/**
 * evacuation-routing.ts
 *
 * Client-side evacuation route calculation.
 * Uses BFS with mobility constraints, fire blocking, and congestion penalties.
 *
 * Congestion penalty pattern (from reference safety.py):
 *   effective_cost = base_distance * congestion_multiplier
 * where multiplier depends on zone congestion status:
 *   NORMAL → 1.0 (no penalty)
 *   HIGH_OCCUPANCY → 1.5
 *   CONGESTED → 3.0
 *   BOTTLENECK → 8.0
 *
 * Wheelchair users:
 *   - Never use stairs
 *   - Prefer routes through ramps
 *   - Accessible-only edges
 */

import type {
  NavigationGraph,
  GraphNode,
  GraphEdge,
} from "./floorplan-graph";

/* ============================================================
   Types
   ============================================================ */

export type MobilityType = "normal" | "wheelchair" | "limited_mobility";

export interface Occupant {
  id: string;
  name: string;
  locationId: string; // element ID where the occupant starts
  mobility: MobilityType;
}

export interface RouteResult {
  occupantId: string;
  occupantName: string;
  success: boolean;
  route: string[]; // node IDs from start to exit
  routeCoords: Array<{ x: number; y: number }>; // pixel coordinates for drawing
  recommendedExit: string;
  distance: number;
  risk: string;
  usesStairs: boolean;
  usesRamp: boolean;
  accessibleRoute: boolean;
  congestionPenalty: number; // total penalty applied to this route
  status:
    | "waiting"
    | "evacuating"
    | "evacuated"
    | "blocked"
    | "no_route";
  message?: string;
}

export interface EvacuationPlan {
  fireRoomId: string;
  blockedNodes: string[];
  blockedEdges: Set<string>;
  routes: RouteResult[];
}

/* ============================================================
   Congestion penalty map (zone_id → multiplier)
   ============================================================ */

export type CongestionPenalties = Record<string, number>;

const DEFAULT_CONGESTION_MULTIPLIER = 1.0;

/**
 * Get the congestion multiplier for a given zone/element ID.
 * Falls back to 1.0 if no penalty data exists.
 */
function getCongestionMultiplier(
  elementId: string,
  penalties: CongestionPenalties
): number {
  return penalties[elementId] ?? DEFAULT_CONGESTION_MULTIPLIER;
}

/* ============================================================
   Graph filtering
   ============================================================ */

/**
 * Filter graph edges based on mobility type.
 * Wheelchair users cannot use stairs.
 */
function filterEdgesForMobility(
  edges: GraphEdge[],
  mobility: MobilityType
): GraphEdge[] {
  return edges.filter((edge) => {
    if (mobility === "wheelchair") {
      // Wheelchair: exclude stairs and non-accessible edges
      if (edge.edgeType === "stairs" || !edge.accessible) return false;
    }
    return true;
  });
}

/**
 * Filter out blocked edges (those passing through fire room).
 */
function filterBlockedEdges(
  edges: GraphEdge[],
  blockedEdges: Set<string>
): GraphEdge[] {
  return edges.filter((edge) => {
    const key = [edge.source, edge.target].sort().join("::");
    return !blockedEdges.has(key);
  });
}

/* ============================================================
   BFS helpers with congestion-weighted paths
   ============================================================ */

/**
 * Build weighted adjacency list from edges.
 * Each neighbor entry includes the base distance and congestion multiplier.
 */
function buildWeightedAdj(
  validEdges: GraphEdge[],
  penalties: CongestionPenalties
): Map<string, Array<{ node: string; weight: number }>> {
  const adj = new Map<string, Array<{ node: string; weight: number }>>();
  for (const edge of validEdges) {
    if (!adj.has(edge.source)) adj.set(edge.source, []);
    if (!adj.has(edge.target)) adj.set(edge.target, []);

    // Apply congestion multiplier to source's edge cost
    // (based on the target zone — entering a congested zone costs more)
    const multSrc = getCongestionMultiplier(edge.target, penalties);
    const multTgt = getCongestionMultiplier(edge.source, penalties);

    adj.get(edge.source)!.push({ node: edge.target, weight: edge.distance * multSrc });
    adj.get(edge.target)!.push({ node: edge.source, weight: edge.distance * multTgt });
  }
  return adj;
}

/**
 * BFS to find shortest (congestion-weighted) path from start to ANY exit.
 * Returns { path, targetId, totalWeight } or null.
 */
function bfsToAnyExit(
  startId: string,
  exitIds: string[],
  validEdges: GraphEdge[],
  penalties: CongestionPenalties
): { path: string[]; targetId: string; totalWeight: number } | null {
  const adj = buildWeightedAdj(validEdges, penalties);

  const visited = new Set<string>();
  const queue: Array<{ node: string; path: string[]; weight: number }> = [
    { node: startId, path: [startId], weight: 0 },
  ];
  visited.add(startId);

  while (queue.length > 0) {
    // Sort queue by weight (Dijkstra-lite for small graphs)
    queue.sort((a, b) => a.weight - b.weight);
    const { node, path, weight } = queue.shift()!;

    if (exitIds.includes(node)) {
      return { path, targetId: node, totalWeight: weight };
    }

    const neighbors = adj.get(node) || [];
    for (const next of neighbors) {
      if (!visited.has(next.node)) {
        visited.add(next.node);
        queue.push({
          node: next.node,
          path: [...path, next.node],
          weight: weight + next.weight,
        });
      }
    }
  }

  return null;
}

/**
 * BFS to find shortest paths from start to ALL reachable exit nodes.
 * Returns paths sorted by weighted cost (shortest first).
 */
function bfsAllExits(
  startId: string,
  exitIds: string[],
  validEdges: GraphEdge[],
  penalties: CongestionPenalties
): Array<{ path: string[]; targetId: string; totalWeight: number }> {
  const adj = buildWeightedAdj(validEdges, penalties);

  const visited = new Set<string>();
  const queue: Array<{ node: string; path: string[]; weight: number }> = [
    { node: startId, path: [startId], weight: 0 },
  ];
  visited.add(startId);

  const exitPaths: Array<{ path: string[]; targetId: string; totalWeight: number }> = [];
  const foundExits = new Set<string>();

  while (queue.length > 0) {
    queue.sort((a, b) => a.weight - b.weight);
    const { node, path, weight } = queue.shift()!;

    if (exitIds.includes(node) && !foundExits.has(node)) {
      exitPaths.push({ path, targetId: node, totalWeight: weight });
      foundExits.add(node);
    }

    // Continue BFS to find paths to other exits
    const neighbors = adj.get(node) || [];
    for (const next of neighbors) {
      if (!visited.has(next.node)) {
        visited.add(next.node);
        queue.push({
          node: next.node,
          path: [...path, next.node],
          weight: weight + next.weight,
        });
      }
    }
  }

  // Sort by weighted cost (shortest first)
  exitPaths.sort((a, b) => a.totalWeight - b.totalWeight);
  return exitPaths;
}

/**
 * Check if a path passes through any ramp node.
 */
function pathUsesRamp(
  path: string[],
  rampNodeIds: Set<string>
): boolean {
  return path.some((nodeId) => rampNodeIds.has(nodeId));
}

/* ============================================================
   Route analysis
   ============================================================ */

function analyzeRoute(
  path: string[],
  graph: NavigationGraph,
  mobility: MobilityType,
  penalties: CongestionPenalties
): {
  distance: number;
  usesStairs: boolean;
  usesRamp: boolean;
  accessible: boolean;
  risk: string;
  congestionPenalty: number;
} {
  let distance = 0;
  let congestionPenalty = 0;
  let usesStairs = false;
  let usesRamp = false;

  // Build edge lookup
  const edgeMap = new Map<string, GraphEdge>();
  for (const e of graph.edges) {
    const key = [e.source, e.target].sort().join("::");
    edgeMap.set(key, e);
  }

  // Build ramp node set for node-based detection
  const rampNodeIds = new Set(
    graph.nodes.filter((n) => n.type === "ramp").map((n) => n.id)
  );

  for (let i = 0; i < path.length - 1; i++) {
    const key = [path[i], path[i + 1]].sort().join("::");
    const edge = edgeMap.get(key);
    if (edge) {
      const mult = getCongestionMultiplier(path[i + 1], penalties);
      distance += edge.distance;
      congestionPenalty += edge.distance * (mult - 1.0); // extra cost from congestion
      if (edge.edgeType === "stairs") usesStairs = true;
    }
    // Detect ramp usage by checking if any node in the path is a ramp element
    if (rampNodeIds.has(path[i]) || rampNodeIds.has(path[i + 1])) {
      usesRamp = true;
    }
  }

  const accessible = mobility === "wheelchair" ? !usesStairs : true;
  const effectiveDistance = distance + congestionPenalty;
  const risk =
    effectiveDistance < 50 ? "LOW" : effectiveDistance < 150 ? "MEDIUM" : "HIGH";

  return {
    distance: Math.round(distance * 10) / 10,
    usesStairs,
    usesRamp,
    accessible,
    risk,
    congestionPenalty: Math.round(congestionPenalty * 10) / 10,
  };
}

/* ============================================================
   Main: calculate evacuation plan
   ============================================================ */

export function calculateEvacuation(
  graph: NavigationGraph,
  occupants: Occupant[],
  fireRoomId: string,
  blockedNodeIds: string[],
  blockedEdgeKeys: Set<string>,
  congestionPenalties: CongestionPenalties = {}
): EvacuationPlan {
  // Find exit nodes
  const exitNodes = graph.nodes.filter((n) => n.type === "exit");
  const exitIds = exitNodes.map((n) => n.id);

  // Identify ramp nodes for wheelchair preference
  const rampNodeIds = new Set(
    graph.nodes.filter((n) => n.type === "ramp").map((n) => n.id)
  );

  const routes: RouteResult[] = [];

  for (const occupant of occupants) {
    // Find the navigation node closest to the occupant's location
    const startNode = graph.nodes.find(
      (n) => n.elementId === occupant.locationId
    );

    if (!startNode) {
      routes.push({
        occupantId: occupant.id,
        occupantName: occupant.name,
        success: false,
        route: [],
        routeCoords: [],
        recommendedExit: "",
        distance: 0,
        risk: "HIGH",
        usesStairs: false,
        usesRamp: false,
        accessibleRoute: false,
        congestionPenalty: 0,
        status: "no_route",
        message: `No navigation node found at ${occupant.locationId}`,
      });
      continue;
    }

    // Check if occupant is in the fire room
    if (blockedNodeIds.includes(startNode.id)) {
      routes.push({
        occupantId: occupant.id,
        occupantName: occupant.name,
        success: false,
        route: [],
        routeCoords: [],
        recommendedExit: "",
        distance: 0,
        risk: "HIGH",
        usesStairs: false,
        usesRamp: false,
        accessibleRoute: false,
        congestionPenalty: 0,
        status: "blocked",
        message: "⚠ Occupant is in the fire zone!",
      });
      continue;
    }

    // Filter edges for mobility
    let validEdges = filterEdgesForMobility(graph.edges, occupant.mobility);
    validEdges = filterBlockedEdges(validEdges, blockedEdgeKeys);

    // Remove edges to/from blocked nodes
    validEdges = validEdges.filter(
      (e) =>
        !blockedNodeIds.includes(e.source) && !blockedNodeIds.includes(e.target)
    );

    let result: { path: string[]; targetId: string; totalWeight: number } | null = null;

    if (occupant.mobility === "wheelchair" && rampNodeIds.size > 0) {
      // ====================================================
      // WHEELCHAIR: prefer routes that pass through a ramp
      // ====================================================
      const allExitPaths = bfsAllExits(startNode.id, exitIds, validEdges, congestionPenalties);

      if (allExitPaths.length > 0) {
        // Separate into ramp paths and non-ramp paths
        const rampPaths = allExitPaths.filter((p) =>
          pathUsesRamp(p.path, rampNodeIds)
        );

        if (rampPaths.length > 0) {
          // Prefer the shortest path that goes through a ramp
          result = rampPaths[0]; // already sorted by weighted cost
        } else {
          // No ramp path available — use shortest accessible path
          result = allExitPaths[0];
        }
      }
    } else {
      // ====================================================
      // NORMAL / LIMITED MOBILITY: shortest path to any exit
      // ====================================================
      result = bfsToAnyExit(startNode.id, exitIds, validEdges, congestionPenalties);
    }

    if (!result) {
      routes.push({
        occupantId: occupant.id,
        occupantName: occupant.name,
        success: false,
        route: [],
        routeCoords: [],
        recommendedExit: "",
        distance: 0,
        risk: "HIGH",
        usesStairs: false,
        usesRamp: false,
        accessibleRoute: false,
        congestionPenalty: 0,
        status: "no_route",
        message: "⚠ No Safe Evacuation Route Available",
      });
      continue;
    }

    const analysis = analyzeRoute(
      result.path,
      graph,
      occupant.mobility,
      congestionPenalties
    );
    const routeCoords = result.path.map((nodeId) => {
      const node = graph.nodes.find((n) => n.id === nodeId)!;
      return { x: node.x, y: node.y };
    });

    routes.push({
      occupantId: occupant.id,
      occupantName: occupant.name,
      success: true,
      route: result.path,
      routeCoords,
      recommendedExit: result.targetId,
      distance: analysis.distance,
      risk: analysis.risk,
      usesStairs: analysis.usesStairs,
      usesRamp: analysis.usesRamp,
      accessibleRoute: analysis.accessible,
      congestionPenalty: analysis.congestionPenalty,
      status: "waiting",
    });
  }

  return {
    fireRoomId,
    blockedNodes: blockedNodeIds,
    blockedEdges: blockedEdgeKeys,
    routes,
  };
}
