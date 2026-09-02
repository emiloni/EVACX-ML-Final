import networkx as nx
import math


def build_semantic_graph(environment):

    graph = nx.Graph()

    nodes = environment["nodes"]

    # ----------------------------------
    # Add nodes
    # ----------------------------------

    for node in nodes:

        graph.add_node(
            node["id"],
            type=node["type"],
            label=node.get("label"),
            x=node["x"],
            y=node["y"],
            confidence=node.get(
                "confidence",
                1.0
            ),
            hazard=0,
            congestion=0
        )

    # ----------------------------------
    # Connect start to exits
    #
    # MVP spatial abstraction
    # ----------------------------------

    start = graph.nodes["start"]

    for node in nodes:

        if node["type"] != "exit":
            continue

        distance = math.sqrt(
            (start["x"] - node["x"]) ** 2 +
            (start["y"] - node["y"]) ** 2
        )

        graph.add_edge(
            "start",
            node["id"],
            distance=distance,
            hazard=0,
            congestion=0,
            blocked=False
        )

    return graph