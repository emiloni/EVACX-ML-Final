"""Evacuation simulation engine.

Takes a corrected floor plan → builds navigation graph → applies
hazard constraints → applies mobility constraints → routes each occupant.

Core workflow:
    FLOOR PLAN ELEMENTS
            ↓
    NAVIGATION GRAPH (nodes + edges)
            ↓
    FIRE / HAZARD APPLICATION
            ↓
    PER-OCCUPANT MOBILITY CONSTRAINTS
            ↓
    ROUTE CALCULATION
            ↓
    VALIDATED EVACUATION RESULTS
"""

from __future__ import annotations

import math
import logging
from typing import Optional

import networkx as nx

logger = logging.getLogger(__name__)


# ================================================================
# Constants
# ================================================================

MOBILITY_TYPES = {"normal", "wheelchair", "limited_mobility", "elderly"}

# Edges that are forbidden for wheelchair users
WHEELCHAIR_FORBIDDEN_TYPES = {"stairs", "staircase", "stairway"}

# Default hazard costs
DEFAULT_FIRE_BLOCK_COST = 10000
DEFAULT_ADJACENT_PENALTY = 500


# ================================================================
# Graph construction from floor plan elements
# ================================================================

def build_navigation_graph(elements: list[dict]) -> nx.Graph:
    """Convert floor-plan elements into a navigation graph.

    Each element becomes a node.  Edges connect nodes that are
    spatially close enough to represent a navigable connection.
    """
    graph = nx.Graph()

    # --- Add nodes ---
    for el in elements:
        el_type = el.get("type", "unknown")
        node_id = el.get("id", f"node_{len(graph.nodes)}")
        x = el.get("x", 0) + el.get("width", 0) / 2
        y = el.get("y", 0) + el.get("height", 0) / 2
        confidence = el.get("confidence", 1.0)
        source = el.get("source", "ai_detected")

        graph.add_node(
            node_id,
            type=el_type,
            x=x,
            y=y,
            confidence=confidence,
            source=source,
            hazard=0.0,
            congestion=0.0,
            wheelchair_accessible=(el_type not in WHEELCHAIR_FORBIDDEN_TYPES),
        )

    # --- Add edges between spatially close nodes ---
    node_ids = list(graph.nodes)
    for i in range(len(node_ids)):
        for j in range(i + 1, len(node_ids)):
            a_id, b_id = node_ids[i], node_ids[j]
            a_data = graph.nodes[a_id]
            b_data = graph.nodes[b_id]

            d = math.sqrt(
                (a_data["x"] - b_data["x"]) ** 2
                + (a_data["y"] - b_data["y"]) ** 2
            )

            # Connect nodes within a reasonable distance
            # Also always connect corridor to its adjacent elements
            a_type = a_data.get("type", "")
            b_type = b_data.get("type", "")

            max_dist = 400  # Default max connection distance

            # Corridors connect to nearby doors, exits, stairs, etc.
            if a_type == "corridor" or b_type == "corridor":
                max_dist = max(max_dist, 500)

            # Doors connect to nearby rooms
            if a_type == "door" or b_type == "door":
                max_dist = max(max_dist, 350)

            # Stairs/ramps/elevators connect to nearby corridors
            if a_type in {"stairs", "ramp", "elevator"} or b_type in {"stairs", "ramp", "elevator"}:
                max_dist = max(max_dist, 450)

            # Exits connect to nearby corridors and ramps
            if a_type == "exit" or b_type == "exit":
                max_dist = max(max_dist, 350)

            if d <= max_dist:
                edge_type = _infer_edge_type(a_type, b_type)
                wheelchair_ok = edge_type not in WHEELCHAIR_FORBIDDEN_TYPES
                graph.add_edge(
                    a_id,
                    b_id,
                    distance=d,
                    edge_type=edge_type,
                    accessible=wheelchair_ok,
                    hazard=0.0,
                    congestion=0.0,
                    blocked=False,
                )

    return graph


def _infer_edge_type(type_a: str, type_b: str) -> str:
    """Infer the edge type from the two connected node types."""
    for t in (type_a, type_b):
        if t in WHEELCHAIR_FORBIDDEN_TYPES:
            return "stairs"
        if t == "ramp":
            return "ramp"
        if t == "elevator":
            return "elevator"
        if t == "door":
            return "door"
    return "corridor"


# ================================================================
# Hazard application
# ================================================================

def apply_hazard(
    graph: nx.Graph,
    fire_room_id: str,
    block_cost: float = DEFAULT_FIRE_BLOCK_COST,
    adjacent_penalty: float = DEFAULT_ADJACENT_PENALTY,
) -> dict:
    """Mark fire room as hazardous and penalise nearby nodes.

    Returns a dict describing what was blocked.
    """
    blocked_nodes = []
    hazard_edges = 0

    if fire_room_id not in graph.nodes:
        logger.warning("[SIM] Fire room %s not in graph", fire_room_id)
        return {"blocked_nodes": blocked_nodes, "hazard_edges": hazard_edges}

    # Block the fire room itself
    graph.nodes[fire_room_id]["hazard"] = block_cost
    blocked_nodes.append(fire_room_id)

    # Penalise adjacent nodes (one hop away)
    for neighbor in graph.neighbors(fire_room_id):
        current = graph.nodes[neighbor].get("hazard", 0)
        graph.nodes[neighbor]["hazard"] = current + adjacent_penalty

    # Block / heavily penalise edges touching the fire room
    for neighbor in list(graph.neighbors(fire_room_id)):
        edge_data = graph[fire_room_id][neighbor]
        edge_data["hazard"] = block_cost
        edge_data["blocked"] = True
        hazard_edges += 1

    # Penalise edges to adjacent nodes (not blocked, just expensive)
    for node_a in blocked_nodes:
        for neighbor in graph.neighbors(node_a):
            if neighbor not in blocked_nodes:
                edge_data = graph[node_a][neighbor]
                if not edge_data.get("blocked", False):
                    edge_data["hazard"] = max(
                        edge_data.get("hazard", 0),
                        adjacent_penalty,
                    )

    logger.info(
        "[SIM] Hazard applied: %s blocked, %d adjacent penalised, %d edges blocked",
        fire_room_id,
        len(blocked_nodes) - 1,
        hazard_edges,
    )

    return {"blocked_nodes": blocked_nodes, "hazard_edges": hazard_edges}


# ================================================================
# Mobility constraints
# ================================================================

def apply_mobility_constraints(
    graph: nx.Graph,
    mobility: str,
) -> nx.Graph:
    """Return a derived graph with mobility-incompatible edges removed.

    For wheelchair users, stairs edges are removed entirely.
    The original graph is NOT mutated.
    """
    g = graph.copy()

    if mobility == "wheelchair":
        edges_to_remove = []
        for u, v, data in g.edges(data=True):
            edge_type = data.get("edge_type", "")
            target_type_u = g.nodes[u].get("type", "")
            target_type_v = g.nodes[v].get("type", "")

            if (
                edge_type in WHEELCHAIR_FORBIDDEN_TYPES
                or target_type_u in WHEELCHAIR_FORBIDDEN_TYPES
                or target_type_v in WHEELCHAIR_FORBIDDEN_TYPES
            ):
                edges_to_remove.append((u, v))

        g.remove_edges_from(edges_to_remove)
        logger.info(
            "[SIM] Wheelchair constraints: removed %d stairs edges",
            len(edges_to_remove),
        )

    elif mobility == "limited_mobility":
        # Higher cost for stairs, but not forbidden
        for u, v, data in g.edges(data=True):
            if data.get("edge_type") in WHEELCHAIR_FORBIDDEN_TYPES:
                data["hazard"] = data.get("hazard", 0) + 2000

    elif mobility == "elderly":
        for u, v, data in g.edges(data=True):
            if data.get("edge_type") in WHEELCHAIR_FORBIDDEN_TYPES:
                data["hazard"] = data.get("hazard", 0) + 500

    return g


# ================================================================
# Route calculation
# ================================================================

def calculate_route_for_occupant(
    graph: nx.Graph,
    start_node: str,
    mobility: str = "normal",
) -> dict:
    """Find the best evacuation route from start_node to the nearest exit.

    Returns a result dict with route details.
    """
    if start_node not in graph.nodes:
        return {
            "success": False,
            "reason": "START_NOT_FOUND",
            "message": f"Occupant location '{start_node}' not found in building.",
        }

    # Find exits
    exits = [
        n for n, d in graph.nodes(data=True)
        if d.get("type") == "exit"
    ]

    if not exits:
        return {
            "success": False,
            "reason": "NO_EXITS",
            "message": "No exits found in the building.",
        }

    # Apply mobility constraints
    constrained_graph = apply_mobility_constraints(graph, mobility)

    # Check start still exists (might have been disconnected)
    if start_node not in constrained_graph.nodes:
        return {
            "success": False,
            "reason": "DISCONNECTED",
            "message": "Occupant location is disconnected in this mobility mode.",
        }

    # Find reachable exits
    reachable_exits = []
    for ex in exits:
        if ex in constrained_graph.nodes:
            reachable_exits.append(ex)

    if not reachable_exits:
        if mobility == "wheelchair":
            return {
                "success": False,
                "reason": "NO_ACCESSIBLE_ROUTE",
                "message": "No safe accessible route to an exit is currently available.",
            }
        return {
            "success": False,
            "reason": "NO_ROUTE",
            "message": "No safe route to an exit is currently available.",
        }

    # Route to each exit, pick best
    def weight(u, v, data):
        if data.get("blocked", False):
            return float("inf")
        cost = data.get("distance", 1)
        cost += data.get("hazard", 0)
        cost += data.get("congestion", 0) * 100
        return cost

    best_route = None
    best_exit = None
    best_cost = float("inf")

    for ex in reachable_exits:
        try:
            route = nx.shortest_path(
                constrained_graph, start_node, ex, weight=weight
            )
            total_cost = sum(
                weight(a, b, constrained_graph[a][b])
                for a, b in zip(route[:-1], route[1:])
            )
            if total_cost < best_cost:
                best_cost = total_cost
                best_route = route
                best_exit = ex
        except (nx.NetworkXNoPath, nx.NodeNotFound):
            continue

    if best_route is None:
        return {
            "success": False,
            "reason": "NO_ROUTE",
            "message": "No safe route to an exit is currently available.",
        }

    # Analyse route for accessibility info
    uses_stairs = False
    uses_ramp = False
    uses_elevator = False
    for a, b in zip(best_route[:-1], best_route[1:]):
        edge_data = constrained_graph[a][b]
        et = edge_data.get("edge_type", "")
        if et == "stairs":
            uses_stairs = True
        elif et == "ramp":
            uses_ramp = True
        elif et == "elevator":
            uses_elevator = True

    # Risk assessment
    if best_cost < 100:
        risk = "LOW"
    elif best_cost < 500:
        risk = "MEDIUM"
    else:
        risk = "HIGH"

    return {
        "success": True,
        "route": best_route,
        "recommended_exit": constrained_graph.nodes[best_exit].get("label", best_exit),
        "exit_id": best_exit,
        "cost": round(best_cost, 2),
        "risk": risk,
        "mobility": mobility,
        "accessible_route": mobility == "wheelchair",
        "uses_stairs": uses_stairs,
        "uses_ramp": uses_ramp,
        "uses_elevator": uses_elevator,
        "distance": round(best_cost, 2),
    }


# ================================================================
# Full evacuation simulation
# ================================================================

def run_evacuation(
    floor_plan_elements: list[dict],
    fire_room_id: str,
    occupants: list[dict],
) -> dict:
    """Run a complete evacuation simulation.

    Parameters
    ----------
    floor_plan_elements : list of floor plan element dicts
    fire_room_id : ID of the room where fire starts
    occupants : list of dicts with keys: id, name, location_id, mobility

    Returns
    -------
    dict with hazard info and per-occupant evacuation results
    """
    logger.info(
        "[SIM] Evacuation: fire=%s, occupants=%d",
        fire_room_id,
        len(occupants),
    )

    # 1. Build navigation graph
    graph = build_navigation_graph(floor_plan_elements)
    logger.info("[SIM] Graph: %d nodes, %d edges", graph.number_of_nodes(), graph.number_of_edges())

    # 2. Apply hazard
    hazard_info = apply_hazard(graph, fire_room_id)

    # 3. Route each occupant
    evacuations = []
    for occ in occupants:
        occ_id = occ.get("id", "unknown")
        location = occ.get("location_id", "")
        mobility = occ.get("mobility", "normal")
        name = occ.get("name", occ_id)

        result = calculate_route_for_occupant(graph, location, mobility)
        result["occupant_id"] = occ_id
        result["occupant_name"] = name
        result["location_id"] = location
        evacuations.append(result)

    logger.info(
        "[SIM] Results: %d/%d successful",
        sum(1 for e in evacuations if e["success"]),
        len(evacuations),
    )

    return {
        "success": True,
        "hazard": {
            "type": "fire",
            "room_id": fire_room_id,
            **hazard_info,
        },
        "graph": {
            "nodes": [
                {"id": n, **d}
                for n, d in graph.nodes(data=True)
            ],
            "edges": [
                {"source": u, "target": v, **d}
                for u, v, d in graph.edges(data=True)
            ],
        },
        "evacuations": evacuations,
    }
