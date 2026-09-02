/**
 * floorplan-graph.ts
 *
 * Builds a navigation graph from floor plan elements.
 * Creates nodes at element centers and edges between
 * physically adjacent/connected elements.
 *
 * Uses a multi-pass strategy:
 *   1. Connect doors to adjacent rooms/corridors.
 *   2. Connect non-door elements within proximity threshold.
 *   3. Force-connect every room to the nearest corridor (fallback).
 *   4. Force-connect every exit to the nearest corridor/room (fallback).
 *   5. Ensure the graph is connected — if an element is isolated,
 *      link it to its nearest neighbor.
 */

export interface GraphNode {
  id: string;
  elementId: string;
  type: string;
  x: number;
  y: number;
  label: string;
}

export interface GraphEdge {
  source: string;
  target: string;
  distance: number;
  accessible: boolean;
  edgeType: string; // "door" | "corridor" | "exit" | "stairs" | "ramp" | "direct"
  blocked: boolean;
}

export interface NavigationGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

interface FloorElement {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number;
  wheelchair_accessible?: boolean;
}

/** Compute center of a floor element */
function center(el: FloorElement): { x: number; y: number } {
  return {
    x: el.x + el.width / 2,
    y: el.y + el.height / 2,
  };
}

/** Distance between two points */
function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

/** Edge-to-edge distance between two axis-aligned rectangles (0 if overlapping) */
function edgeDistance(a: FloorElement, b: FloorElement): number {
  const dx = Math.max(0, Math.max(a.x, b.x) - Math.min(a.x + a.width, b.x + b.width));
  const dy = Math.max(0, Math.max(a.y, b.y) - Math.min(a.y + a.height, b.y + b.height));
  return Math.sqrt(dx * dx + dy * dy);
}

/** Check if element A overlaps or is within threshold of B */
function isConnected(a: FloorElement, b: FloorElement, threshold: number): boolean {
  return edgeDistance(a, b) <= threshold;
}

/**
 * Build a navigation graph from floor plan elements.
 *
 * Strategy:
 * 1. Create a node for the center of each element.
 * 2. Connect doors to nearby rooms/corridors (generous threshold).
 * 3. Connect non-door elements that are physically adjacent.
 * 4. Force-connect rooms to nearest corridor.
 * 5. Force-connect exits/stairs/ramps to nearest corridor or room.
 * 6. Ensure every node has at least one edge (connect to nearest neighbor).
 */
export function buildNavigationGraph(elements: FloorElement[]): NavigationGraph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const nodeMap = new Map<string, GraphNode>();
  const edgeSet = new Set<string>();

  // Create nodes
  for (const el of elements) {
    const c = center(el);
    const node: GraphNode = {
      id: el.id,
      elementId: el.id,
      type: el.type,
      x: c.x,
      y: c.y,
      label: el.id,
    };
    nodes.push(node);
    nodeMap.set(el.id, node);
  }

  // Compute element dimensions for adaptive threshold
  const avgWidth =
    elements.reduce((s, e) => s + e.width, 0) / (elements.length || 1);
  const avgHeight =
    elements.reduce((s, e) => s + e.height, 0) / (elements.length || 1);
  const avgDim = (avgWidth + avgHeight) / 2;

  // Adaptive threshold: generous enough for AI-generated plans
  // Use max of (average dimension, 80px) to ensure connectivity
  const CONNECT_THRESHOLD = Math.max(avgDim * 1.5, 80);
  const DOOR_THRESHOLD = Math.max(avgDim * 2.0, 120);

  console.log(
    "[GRAPH] Elements:",
    elements.length,
    "avgDim:",
    avgDim.toFixed(1),
    "CONNECT_THRESHOLD:",
    CONNECT_THRESHOLD.toFixed(1),
    "DOOR_THRESHOLD:",
    DOOR_THRESHOLD.toFixed(1)
  );

  const addEdge = (
    sourceId: string,
    targetId: string,
    srcEl: FloorElement,
    tgtEl: FloorElement,
    edgeType: string
  ) => {
    const key = [sourceId, targetId].sort().join("::");
    if (edgeSet.has(key)) return;
    edgeSet.add(key);

    const c1 = center(srcEl);
    const c2 = center(tgtEl);
    const accessible =
      srcEl.type !== "stairs" && tgtEl.type !== "stairs";

    edges.push({
      source: sourceId,
      target: targetId,
      distance: dist(c1, c2),
      accessible,
      edgeType,
      blocked: false,
    });
  };

  // Group elements by type
  const doors = elements.filter((e) => e.type === "door");
  const corridors = elements.filter((e) => e.type === "corridor");
  const rooms = elements.filter((e) => e.type === "room");
  const exits = elements.filter((e) => e.type === "exit");
  const stairs = elements.filter((e) => e.type === "stairs");
  const ramps = elements.filter((e) => e.type === "ramp");
  const elevators = elements.filter((e) => e.type === "elevator");

  // ──────────────────────────────────────────────────────────
  // Pass 1: Connect doors to adjacent rooms/corridors
  // ──────────────────────────────────────────────────────────
  for (const door of doors) {
    const adjacent = elements
      .filter((e) => e.id !== door.id && isConnected(door, e, DOOR_THRESHOLD))
      .sort((a, b) => edgeDistance(door, a) - edgeDistance(door, b));

    // Connect door to up to 3 nearest elements
    for (const target of adjacent.slice(0, 3)) {
      addEdge(door.id, target.id, door, target, "door");
    }
  }

  // ──────────────────────────────────────────────────────────
  // Pass 2: Connect non-door elements within proximity threshold
  // ──────────────────────────────────────────────────────────
  const nonDoors = elements.filter((e) => e.type !== "door");
  for (let i = 0; i < nonDoors.length; i++) {
    for (let j = i + 1; j < nonDoors.length; j++) {
      const a = nonDoors[i];
      const b = nonDoors[j];
      if (!isConnected(a, b, CONNECT_THRESHOLD)) continue;

      const edgeType =
        a.type === "exit" || b.type === "exit"
          ? "exit"
          : a.type === "stairs" || b.type === "stairs"
            ? "stairs"
            : a.type === "ramp" || b.type === "ramp"
              ? "ramp"
              : "direct";

      addEdge(a.id, b.id, a, b, edgeType);
    }
  }

  // ──────────────────────────────────────────────────────────
  // Pass 3: Force-connect each room to nearest corridor
  // (rooms are the main sources of occupants)
  // ──────────────────────────────────────────────────────────
  if (corridors.length > 0) {
    for (const room of rooms) {
      const hasEdge = edges.some(
        (e) => e.source === room.id || e.target === room.id
      );
      if (hasEdge) continue; // already connected

      const nearest = corridors
        .sort((a, b) => edgeDistance(room, a) - edgeDistance(room, b))[0];
      if (nearest) {
        console.log(
          "[GRAPH] Force-connecting room",
          room.id,
          "→ corridor",
          nearest.id
        );
        addEdge(room.id, nearest.id, room, nearest, "direct");
      }
    }
  }

  // ──────────────────────────────────────────────────────────
  // Pass 4: Force-connect each exit to nearest corridor or room
  // ──────────────────────────────────────────────────────────
  for (const exit of exits) {
    const hasEdge = edges.some(
      (e) => e.source === exit.id || e.target === exit.id
    );
    if (hasEdge) continue;

    const targets = [...corridors, ...rooms].sort(
      (a, b) => edgeDistance(exit, a) - edgeDistance(exit, b)
    );
    if (targets.length > 0) {
      console.log(
        "[GRAPH] Force-connecting exit",
        exit.id,
        "→",
        targets[0].id
      );
      addEdge(exit.id, targets[0].id, exit, targets[0], "exit");
    }
  }

  // ──────────────────────────────────────────────────────────
  // Pass 5: Force-connect stairs, ramps, elevators
  // ──────────────────────────────────────────────────────────
  const specialElements = [...stairs, ...ramps, ...elevators];
  for (const special of specialElements) {
    const hasEdge = edges.some(
      (e) => e.source === special.id || e.target === special.id
    );
    if (hasEdge) continue;

    const targets = [...corridors, ...rooms].sort(
      (a, b) => edgeDistance(special, a) - edgeDistance(special, b)
    );
    if (targets.length > 0) {
      const edgeType =
        special.type === "stairs"
          ? "stairs"
          : special.type === "ramp"
            ? "ramp"
            : "direct";
      console.log(
        "[GRAPH] Force-connecting",
        special.type,
        special.id,
        "→",
        targets[0].id
      );
      addEdge(special.id, targets[0].id, special, targets[0], edgeType);
    }
  }

  // ──────────────────────────────────────────────────────────
  // Pass 6: Ensure connectivity — connect any isolated node
  // to its nearest neighbor (prevents unreachable elements)
  // ──────────────────────────────────────────────────────────
  for (const node of nodes) {
    const hasEdge = edges.some(
      (e) => e.source === node.id || e.target === node.id
    );
    if (hasEdge) continue;

    // Find nearest element (any type)
    let minDist = Infinity;
    let nearestEl: FloorElement | null = null;
    const nodeEl = elements.find((e) => e.id === node.id);
    if (!nodeEl) continue;

    for (const other of elements) {
      if (other.id === node.id) continue;
      const d = edgeDistance(nodeEl, other);
      if (d < minDist) {
        minDist = d;
        nearestEl = other;
      }
    }

    if (nearestEl) {
      console.warn(
        "[GRAPH] Isolated node",
        node.id,
        "(type=" + node.type + ")",
        "→ force-connecting to nearest:",
        nearestEl.id,
        "dist:",
        minDist.toFixed(1)
      );
      addEdge(node.id, nearestEl.id, nodeEl, nearestEl, "direct");
    }
  }

  console.log(
    "[GRAPH] Final graph:",
    nodes.length,
    "nodes,",
    edges.length,
    "edges"
  );
  if (edges.length === 0) {
    console.error("[GRAPH] CRITICAL: No edges generated! Check element positions.");
  }

  return { nodes, edges };
}

/**
 * Get the center coordinates of a floor element by its ID.
 */
export function getElementCenter(
  elements: FloorElement[],
  elementId: string
): { x: number; y: number } | null {
  const el = elements.find((e) => e.id === elementId);
  return el ? center(el) : null;
}

/**
 * Check if a navigation node is inside a given room element.
 */
export function isNodeInRoom(
  node: GraphNode,
  roomId: string,
  elements: FloorElement[]
): boolean {
  const room = elements.find((e) => e.id === roomId);
  if (!room) return false;
  return (
    node.x >= room.x && node.x <= room.x + room.width && node.y >= room.y && node.y <= room.y + room.height
  );
}

/**
 * Find all navigation nodes that are inside a given room.
 */
export function getNodesInRoom(
  graph: NavigationGraph,
  roomId: string,
  elements: FloorElement[]
): string[] {
  return graph.nodes
    .filter((n) => isNodeInRoom(n, roomId, elements))
    .map((n) => n.id);
}
