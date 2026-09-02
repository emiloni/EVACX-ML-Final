import networkx as nx


def create_demo_graph():

    graph = nx.Graph()

    # ==========================================
    # NODES
    # ==========================================

    graph.add_node(
        "start",
        type="current_position",
        label="YOU ARE HERE",
        x=450,
        y=470
    )

    graph.add_node(
        "corridor",
        type="corridor",
        label="MAIN CORRIDOR",
        x=700,
        y=470
    )

    graph.add_node(
        "stairs",
        type="stairs",
        label="STAIRS",
        x=450,
        y=350,
        wheelchair_accessible=False
    )

    graph.add_node(
        "ramp",
        type="ramp",
        label="ACCESSIBLE RAMP",
        x=620,
        y=570,
        wheelchair_accessible=True
    )

    graph.add_node(
        "exit_a",
        type="exit",
        label="EXIT A",
        x=210,
        y=280
    )

    graph.add_node(
        "exit_b",
        type="exit",
        label="EXIT B",
        x=710,
        y=270
    )

    graph.add_node(
        "exit_c",
        type="exit",
        label="EXIT C",
        x=1140,
        y=300
    )

    # ==========================================
    # ROUTES
    # ==========================================

    graph.add_edge(
        "start",
        "stairs",
        distance=20,
        hazard=0,
        congestion=0,
        blocked=False,
        stairs=True
    )

    graph.add_edge(
        "stairs",
        "exit_a",
        distance=25,
        hazard=0,
        congestion=0,
        blocked=False,
        stairs=True
    )

    graph.add_edge(
        "start",
        "corridor",
        distance=25,
        hazard=0,
        congestion=0,
        blocked=False,
        stairs=False
    )

    graph.add_edge(
        "corridor",
        "exit_b",
        distance=30,
        hazard=0,
        congestion=0,
        blocked=False,
        stairs=False
    )

    graph.add_edge(
        "corridor",
        "exit_c",
        distance=45,
        hazard=0,
        congestion=0,
        blocked=False,
        stairs=False
    )

    graph.add_edge(
        "start",
        "ramp",
        distance=30,
        hazard=0,
        congestion=0,
        blocked=False,
        stairs=False
    )

    graph.add_edge(
        "ramp",
        "exit_c",
        distance=35,
        hazard=0,
        congestion=0,
        blocked=False,
        stairs=False
    )

    return graph