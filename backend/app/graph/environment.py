from typing import List, Dict
import math


def center(bbox):
    x1, y1, x2, y2 = bbox
    return (
        (x1 + x2) / 2,
        (y1 + y2) / 2
    )


def distance(a, b):
    return math.sqrt(
        (a["x"] - b["x"]) ** 2 +
        (a["y"] - b["y"]) ** 2
    )


def build_environment(detections):

    people = []
    exits = []
    hazards = []

    for detection in detections:

        dtype = detection["type"]

        if dtype == "person":
            people.append(detection)

        elif dtype in {
            "exit sign",
            "exit door",
            "emergency exit"
        }:
            exits.append(detection)

        elif dtype in {
            "fire",
            "smoke",
            "obstacle",
            "blocked passage"
        }:
            hazards.append(detection)

    # ---------------------------------------
    # Remove duplicate exit detections
    # ---------------------------------------

    unique_exits = []

    for candidate in sorted(
        exits,
        key=lambda x: x["confidence"],
        reverse=True
    ):

        cx, cy = center(
            candidate["bbox"]
        )

        too_close = False

        for existing in unique_exits:

            ex, ey = center(
                existing["bbox"]
            )

            if math.sqrt(
                (cx - ex) ** 2 +
                (cy - ey) ** 2
            ) < 100:

                too_close = True
                break

        if not too_close:

            unique_exits.append(
                candidate
            )

    # ---------------------------------------
    # Current position
    # ---------------------------------------

    if people:

        # Highest-confidence person is used
        # as the observed starting position.
        current = max(
            people,
            key=lambda x: x["confidence"]
        )

        current_x, current_y = center(
            current["bbox"]
        )

    else:

        current_x = 690
        current_y = 450

    # ---------------------------------------
    # Build semantic nodes
    # ---------------------------------------

    nodes = []

    nodes.append({
        "id": "start",
        "type": "current_position",
        "label": "YOU ARE HERE",
        "x": current_x,
        "y": current_y
    })

    for index, exit_detection in enumerate(
        unique_exits
    ):

        x, y = center(
            exit_detection["bbox"]
        )

        nodes.append({
            "id": f"exit_{index + 1}",
            "type": "exit",
            "label": f"EXIT {index + 1}",
            "x": x,
            "y": y,
            "confidence": exit_detection[
                "confidence"
            ]
        })

    return {
        "nodes": nodes,
        "people": len(people),
        "exits": len(unique_exits),
        "hazards": len(hazards),
        "current_position": {
            "x": current_x,
            "y": current_y
        }
    }