/**
 * evacuation-routing.ts
 *
 * Client-side evacuation route calculation.
 * Uses BFS with mobility constraints and fire blocking.
 * Wheelchair users prefer routes through ramps.
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
   BFS helpers
   ============================================================ */

/** Build adjacency list from edges */
function buildAdj(validEdges: GraphEdge[]): Map<string, string[]> {
  const adj = new Map<string, string[]>();
  for (const edge of validEdges) {
    if (!adj.has(edge.source)) adj.set(edge.source, []);
    if (!adj.has(edge.target)) adj.set(edge.target, []);
    adj.get(edge.source)!.push(edge.target);
    adj.get(edge.target)!.push(edge.source);
  }
  return adj;
}

/**
 * BFS to find shortest path from start to ANY of the target nodes.
 * Returns { path, targetId } or null.
 */
function bfsToAnyExit(
  _graph: NavigationGraph,
  startId: string,
  exitIds: string[],
  validEdges: GraphEdge[]
): { path: string[]; targetId: string } | null {
  const adj = buildAdj(validEdges);

  const visited = new Set<string>();
  const queue: Array<{ node: string; path: string[] }> = [
    { node: startId, path: [startId] },
  ];
  visited.add(startId);

  while (queue.length > 0) {
    const { node, path } = queue.shift()!;
    if (exitIds.includes(node)) {
      return { path, targetId: node };
    }

    const neighbors = adj.get(node) || [];
    for (const next of neighbors) {
      if (!visited.has(next)) {
        visited.add(next);
        queue.push({ node: next, path: [...path, next] });
      }
    }
  }

  return null;
}

/**
 * BFS to find shortest paths from start to ALL reachable exit nodes.
 * Returns paths sorted by length (shortest first).
 */
function bfsAllExits(
  startId: string,
  exitIds: string[],
  validEdges: GraphEdge[]
): Array<{ path: string[]; targetId: string }> {
  const adj = buildAdj(validEdges);

  const visited = new Set<string>();
  const queue: Array<{ node: string; path: string[] }> = [
    { node: startId, path: [startId] },
  ];
  visited.add(startId);

  const exitPaths: Array<{ path: string[]; targetId: string }> = [];
  const foundExits = new Set<string>();

  while (queue.length > 0) {
    const { node, path } = queue.shift()!;

    if (exitIds.includes(node) && !foundExits.has(node)) {
      exitPaths.push({ path, targetId: node });
      foundExits.add(node);
    }

    // Continue BFS to find paths to other exits
    const neighbors = adj.get(node) || [];
    for (const next of neighbors) {
      if (!visited.has(next)) {
        visited.add(next);
        queue.push({ node: next, path: [...path, next] });
      }
    }
  }

  // Sort by path length (shortest first)
  exitPaths.sort((a, b) => a.path.length - b.path.length);
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
  mobility: MobilityType
): {
  distance: number;
  usesStairs: boolean;
  usesRamp: boolean;
  accessible: boolean;
  risk: string;
} {
  let distance = 0;
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
      distance += edge.distance;
      if (edge.edgeType === "stairs") usesStairs = true;
    }
    // Detect ramp usage by checking if any node in the path is a ramp element
    if (rampNodeIds.has(path[i]) || rampNodeIds.has(path[i + 1])) {
      usesRamp = true;
    }
  }

  const accessible = mobility === "wheelchair" ? !usesStairs : true;
  const risk = distance < 50 ? "LOW" : distance < 150 ? "MEDIUM" : "HIGH";

  return { distance, usesStairs, usesRamp, accessible, risk };
}

/* ============================================================
   Main: calculate evacuation plan
   ============================================================ */

export function calculateEvacuation(
  graph: NavigationGraph,
  occupants: Occupant[],
  fireRoomId: string,
  blockedNodeIds: string[],
  blockedEdgeKeys: Set<string>
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
        !blockedNodeIds.includes(e.source) &&
        !blockedNodeIds.includes(e.target)
    );

    let result: { path: string[]; targetId: string } | null = null;

    if (occupant.mobility === "wheelchair" && rampNodeIds.size > 0) {
      // ====================================================
      // WHEELCHAIR: prefer routes that pass through a ramp
      // ====================================================
      const allExitPaths = bfsAllExits(startNode.id, exitIds, validEdges);

      if (allExitPaths.length > 0) {
        // Separate into ramp paths and non-ramp paths
        const rampPaths = allExitPaths.filter((p) =>
          pathUsesRamp(p.path, rampNodeIds)
        );

        if (rampPaths.length > 0) {
          // Prefer the shortest path that goes through a ramp
          result = rampPaths[0]; // already sorted by length
        } else {
          // No ramp path available — use shortest accessible path
          result = allExitPaths[0];
        }
      }
    } else {
      // ====================================================
      // NORMAL / LIMITED MOBILITY: shortest path to any exit
      // ====================================================
      result = bfsToAnyExit(graph, startNode.id, exitIds, validEdges);
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
        status: "no_route",
        message: "⚠ No Safe Evacuation Route Available",
      });
      continue;
    }

    const analysis = analyzeRoute(result.path, graph, occupant.mobility);
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
