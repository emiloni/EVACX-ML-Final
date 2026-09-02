/**
 * floorplan-graph.ts
 *
 * Builds a navigation graph from floor plan elements.
 * Creates nodes at element centers and edges between
 * physically adjacent/connected elements.
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
 * 2. Connect elements that are physically adjacent (edge distance < threshold).
 * 3. For doors, they serve as connectors between rooms/corridors.
 * 4. Stairs are marked non-accessible; ramps are accessible.
 * 5. Exits are exit nodes.
 */
export function buildNavigationGraph(elements: FloorElement[]): NavigationGraph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const nodeMap = new Map<string, GraphNode>();

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

  // Connectivity threshold — elements whose edges are within this distance are connected.
  // Doors are thinner, so use a generous threshold.
  const CONNECT_THRESHOLD = 40;

  const seen = new Set<string>();

  // Pass 1: Connect doors to nearby rooms/corridors
  const doors = elements.filter((e) => e.type === "door");
  const nonDoors = elements.filter((e) => e.type !== "door");

  for (const door of doors) {
    const adjacent = nonDoors
      .filter((e) => isConnected(door, e, CONNECT_THRESHOLD))
      .sort((a, b) => edgeDistance(door, a) - edgeDistance(door, b));

    // Connect door to up to 2 nearest non-door elements (the two spaces it bridges)
    const toConnect = adjacent.slice(0, 2);
    for (const target of toConnect) {
      const key = [door.id, target.id].sort().join("::");
      if (seen.has(key)) continue;
      seen.add(key);

      const c1 = center(door);
      const c2 = center(target);
      edges.push({
        source: door.id,
        target: target.id,
        distance: dist(c1, c2),
        accessible: door.type !== "stairs",
        edgeType: "door",
        blocked: false,
      });
    }

    // Also connect door-to-door if two doors are adjacent
    for (const other of doors) {
      if (other.id === door.id) continue;
      if (!isConnected(door, other, CONNECT_THRESHOLD)) continue;
      const key = [door.id, other.id].sort().join("::");
      if (seen.has(key)) continue;
      seen.add(key);
      const c1 = center(door);
      const c2 = center(other);
      edges.push({
        source: door.id,
        target: other.id,
        distance: dist(c1, c2),
        accessible: true,
        edgeType: "direct",
        blocked: false,
      });
    }
  }

  // Pass 2: Connect non-door elements to each other (corridors to rooms, exits to corridors, etc.)
  for (let i = 0; i < nonDoors.length; i++) {
    for (let j = i + 1; j < nonDoors.length; j++) {
      const a = nonDoors[i];
      const b = nonDoors[j];
      if (!isConnected(a, b, CONNECT_THRESHOLD)) continue;

      const key = [a.id, b.id].sort().join("::");
      if (seen.has(key)) continue;
      seen.add(key);

      const c1 = center(a);
      const c2 = center(b);
      const accessible =
        a.type !== "stairs" && b.type !== "stairs";

      edges.push({
        source: a.id,
        target: b.id,
        distance: dist(c1, c2),
        accessible,
        edgeType: a.type === "exit" || b.type === "exit" ? "exit" : "direct",
        blocked: false,
      });
    }
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
    node.x >= room.x &&
    node.x <= room.x + room.width &&
    node.y >= room.y &&
    node.y <= room.y + room.height
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
