import networkx as nx

import logging

logger = logging.getLogger(__name__)


def apply_congestion_penalties(
    graph: nx.Graph,
    penalties: dict[str, float],
) -> None:
    """Apply congestion penalties from occupancy data to graph edges.

    This mutates the graph in-place.  For each node whose ID matches
    a zone in the penalties dict, all adjacent edges get their
    ``congestion`` attribute increased by (penalty - 1.0) * 100.

    This means:
        NORMAL (1.0)     → no change
        HIGH_OCCUPANCY   → +50 congestion cost
        CONGESTED        → +200 congestion cost
        BOTTLENECK       → +700 congestion cost

    The routing engine already multiplies ``congestion`` by 100 in
    its edge_cost function, so these become:
        HIGH_OCCUPANCY   → +5000 effective cost
        CONGESTED        → +20000 effective cost
        BOTTLENECK       → +70000 effective cost

    However, we only penalise — we never fully block a route.
    If a bottlenecked corridor is the only way out, it will still
    be used but at very high cost.
    """
    affected_edges = 0

    for node_id, penalty_mult in penalties.items():
        if node_id not in graph.nodes:
            continue
        if penalty_mult <= 1.0:
            continue  # NORMAL — no penalty

        # Compute the congestion addition
        congestion_add = (penalty_mult - 1.0) * 100

        # Apply to all edges touching this node
        for neighbor in graph.neighbors(node_id):
            edge_data = graph[node_id][neighbor]
            current = edge_data.get("congestion", 0)
            edge_data["congestion"] = current + congestion_add
            affected_edges += 1

    if affected_edges > 0:
        logger.info(
            "[ROUTING] Congestion penalties applied: %d zones penalised, %d edges affected",
            sum(1 for p in penalties.values() if p > 1.0),
            affected_edges,
        )


def apply_hazard_penalties(
    graph: nx.Graph,
    hazards: dict[str, dict],
) -> None:
    """Apply hazard penalties from the sensor store to graph nodes/edges.

    Similar to apply_congestion_penalties but for fire/smoke hazards.
    """
    for zone_id, hazard_info in hazards.items():
        if zone_id not in graph.nodes:
            continue
        if not hazard_info.get("active", True):
            continue

        severity = hazard_info.get("severity", "HIGH")
        hazard_cost = 10000 if severity == "HIGH" else 5000

        graph.nodes[zone_id]["hazard"] = hazard_cost

        # Block edges touching the hazard zone
        for neighbor in list(graph.neighbors(zone_id)):
            edge_data = graph[zone_id][neighbor]
            edge_data["hazard"] = hazard_cost
            edge_data["blocked"] = True

    logger.info("[ROUTING] Hazard penalties applied: %d zones", len(hazards))


def edge_cost(
    graph,
    source,
    target,
    data,
    mobility="normal"
):

    if data.get("blocked", False):
        return float("inf")

    cost = float(
        data.get("distance", 1)
    )

    # Hazard
    cost += float(
        data.get("hazard", 0)
    ) * 1000

    # Congestion
    cost += float(
        data.get("congestion", 0)
    ) * 100

    target_type = graph.nodes[target].get(
        "type",
        ""
    )

    # Wheelchair cannot use stairs
    if mobility == "wheelchair":

        if target_type == "stairs":
            return float("inf")

        if data.get("stairs", False):
            return float("inf")

    # Elderly prefer avoiding stairs
    if mobility == "elderly":

        if data.get("stairs", False):
            cost += 60

    # Temporary injury strongly avoids stairs
    if mobility == "temporary_injury":

        if data.get("stairs", False):
            cost += 120

    return cost


def calculate_route(
    graph,
    mobility="normal"
):

    start = "start"

    exits = [
        node
        for node, data in graph.nodes(
            data=True
        )
        if data.get("type") == "exit"
    ]

    if not exits:

        return {
            "success": False,
            "message": "No exits available."
        }

    def weight(source, target, data):

        return edge_cost(
            graph,
            source,
            target,
            data,
            mobility
        )

    best_route = None
    best_exit = None
    best_cost = float("inf")

    for exit_node in exits:

        try:

            route = nx.shortest_path(
                graph,
                start,
                exit_node,
                weight=weight
            )

            total_cost = 0

            for a, b in zip(
                route[:-1],
                route[1:]
            ):

                total_cost += edge_cost(
                    graph,
                    a,
                    b,
                    graph[a][b],
                    mobility
                )

            if total_cost < best_cost:

                best_cost = total_cost
                best_route = route
                best_exit = exit_node

        except nx.NetworkXNoPath:

            continue

    if best_route is None:

        return {
            "success": False,
            "message": "No safe route available."
        }

    if best_cost < 100:
        risk = "LOW"

    elif best_cost < 300:
        risk = "MEDIUM"

    else:
        risk = "HIGH"

    return {
        "success": True,
        "route": best_route,
        "recommended_exit": graph.nodes[
            best_exit
        ].get(
            "label",
            best_exit
        ),
        "cost": round(
            best_cost,
            2
        ),
        "risk": risk,
        "mobility": mobility
    }