import networkx as nx


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