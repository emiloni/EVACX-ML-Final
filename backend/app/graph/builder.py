import math
import networkx as nx


# Minimum confidence for an exit candidate.
EXIT_CONFIDENCE_THRESHOLD = 0.10

# Maximum distance at which we connect nodes.
MAX_CONNECTION_DISTANCE = 1000


def center(bbox):
    x1, y1, x2, y2 = bbox

    return (
        (x1 + x2) / 2,
        (y1 + y2) / 2
    )


def distance(a, b):
    return math.sqrt(
        (a["x"] - b["x"]) ** 2
        + (a["y"] - b["y"]) ** 2
    )


def build_graph(detections):

    graph = nx.Graph()

    # ------------------------------------------------
    # 1. Find people
    # ------------------------------------------------

    people = [
        d for d in detections
        if d["type"] == "person"
    ]

    # ------------------------------------------------
    # 2. Find candidate exits
    # ------------------------------------------------

    exits = [
        d for d in detections
        if d["type"] in {
            "exit sign",
            "exit door",
            "emergency exit"
        }
        and d["confidence"] >= EXIT_CONFIDENCE_THRESHOLD
    ]

    # ------------------------------------------------
    # 3. Remove duplicate nearby exit detections
    # ------------------------------------------------

    unique_exits = []

    for exit_detection in exits:

        x, y = center(
            exit_detection["bbox"]
        )

        duplicate = False

        for existing in unique_exits:

            ex, ey = center(
                existing["bbox"]
            )

            if math.sqrt(
                (x - ex) ** 2 +
                (y - ey) ** 2
            ) < 80:

                duplicate = True
                break

        if not duplicate:
            unique_exits.append(
                exit_detection
            )

    # ------------------------------------------------
    # 4. Determine current position
    # ------------------------------------------------

    if people:

        # Highest confidence person
        # becomes current user position.
        user = max(
            people,
            key=lambda x: x["confidence"]
        )

        user_x, user_y = center(
            user["bbox"]
        )

    else:

        # If no person is detected,
        # use image center as fallback.
        user_x = 640
        user_y = 360

    graph.add_node(
        "start",
        type="current_position",
        x=user_x,
        y=user_y,
        confidence=1.0
    )

    # ------------------------------------------------
    # 5. Add exit nodes
    # ------------------------------------------------

    exit_nodes = []

    for index, exit_detection in enumerate(
        unique_exits
    ):

        x, y = center(
            exit_detection["bbox"]
        )

        node_id = f"exit_{index + 1}"

        graph.add_node(
            node_id,
            type="exit",
            label=f"EXIT {index + 1}",
            x=x,
            y=y,
            confidence=exit_detection[
                "confidence"
            ],
            hazard=0.0,
            congestion=0.0,
            wheelchair_accessible=True
        )

        exit_nodes.append(node_id)

    # ------------------------------------------------
    # 6. Add detected architectural objects
    # ------------------------------------------------

    architectural_types = {
        "door",
        "doorway",
        "stairs",
        "staircase",
        "stairway",
        "ramp",
        "wheelchair ramp",
        "elevator",
        "corridor",
        "hallway"
    }

    architectural_nodes = []

    for index, detection in enumerate(
        detections
    ):

        if detection["type"] not in architectural_types:
            continue

        x, y = center(
            detection["bbox"]
        )

        node_id = f"environment_{index}"

        graph.add_node(
            node_id,
            type=detection["type"],
            x=x,
            y=y,
            confidence=detection["confidence"],
            hazard=0.0,
            congestion=0.0,
            wheelchair_accessible=(
                detection["type"]
                not in {
                    "stairs",
                    "staircase",
                    "stairway"
                }
            )
        )

        architectural_nodes.append(
            node_id
        )

    # ------------------------------------------------
    # 7. Connect user to all navigational objects
    # ------------------------------------------------

    navigational_nodes = (
        exit_nodes +
        architectural_nodes
    )

    for node_id in navigational_nodes:

        node = graph.nodes[node_id]

        d = distance(
            {
                "x": user_x,
                "y": user_y
            },
            node
        )

        if d <= MAX_CONNECTION_DISTANCE:

            graph.add_edge(
                "start",
                node_id,
                distance=d,
                hazard=0.0,
                congestion=0.0,
                blocked=False
            )

    # ------------------------------------------------
    # 8. Connect navigational objects together
    # ------------------------------------------------

    for i in range(
        len(navigational_nodes)
    ):

        for j in range(i + 1,
                       len(navigational_nodes)):

            node_a = navigational_nodes[i]
            node_b = navigational_nodes[j]

            data_a = graph.nodes[node_a]
            data_b = graph.nodes[node_b]

            d = distance(
                data_a,
                data_b
            )

            if d <= MAX_CONNECTION_DISTANCE:

                graph.add_edge(
                    node_a,
                    node_b,
                    distance=d,
                    hazard=0.0,
                    congestion=0.0,
                    blocked=False
                )

    return graph, exit_nodes