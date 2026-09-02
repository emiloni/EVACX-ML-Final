"""Corridor-based floor plan generator for single-image analysis.

Layout mapping from photo to floor plan:

    PHOTO PERSPECTIVE          FLOOR PLAN
    ─────────────────          ──────────
    Camera → looking down      Corridor runs left → right
    hallway

    Left wall (top of image)   ABOVE corridor (rooms, doors)
    Right wall (bottom)        BELOW corridor (rooms, doors)
    Far end (right of image)   RIGHT END of corridor (exit)
    Near end (left of image)   LEFT END of corridor (entrance)

Coordinate mapping:
    image center_x (0→1) → corridor x (left→right / depth)
    image center_y (0→1) → corridor y position
                               < 0.5 → above corridor (left wall)
                               >= 0.5 → below corridor (right wall)
"""

from __future__ import annotations

import logging
import uuid

logger = logging.getLogger(__name__)

# -------------------------------------------------------
# Floor plan coordinate space
# -------------------------------------------------------
FP_WIDTH = 1000
FP_HEIGHT = 600

# Corridor geometry
CORRIDOR_X = 50           # left edge
CORRIDOR_W = 900          # width
CORRIDOR_Y = 250          # top edge
CORRIDOR_H = 100          # height

# Room geometry
ROOM_W = 160
ROOM_H = 130
ROOM_GAP = 8              # gap between room and corridor

# Element sizes
DOOR_W = 50
DOOR_H = 10
EXIT_SIZE = 55
STAIRS_W = 120
STAIRS_H = 100


def _fp_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:8]}"


def _clamp(val: float, lo: float, hi: float) -> float:
    return max(lo, min(val, hi))


def _map_x_to_corridor(cx: float) -> float:
    """Map image normalised x (0→1) to corridor x coordinate."""
    return CORRIDOR_X + cx * CORRIDOR_W


def generate_floor_plan(landmarks: list[dict]) -> dict:
    """Generate a position-aware floor plan from semantic landmarks.

    Parameters
    ----------
    landmarks : list of landmark dicts from ``generate_landmarks()``.
        Each has ``type``, ``center_x``, ``center_y``, ``confidence``.

    Returns
    -------
    dict with width, height, units, approximate, elements.
    """
    elements: list[dict] = []

    # --------------------------------------------------
    # 1. Corridor (always the backbone)
    # --------------------------------------------------
    corridor_id = _fp_id("corridor")
    elements.append({
        "id": corridor_id,
        "type": "corridor",
        "x": CORRIDOR_X,
        "y": CORRIDOR_Y,
        "width": CORRIDOR_W,
        "height": CORRIDOR_H,
        "wheelchair_accessible": True,
    })

    # --------------------------------------------------
    # 2. Classify landmarks
    # --------------------------------------------------
    doors = [lm for lm in landmarks if lm["type"] == "door"]
    exits = [lm for lm in landmarks if lm["type"] == "exit"]
    stairs_list = [lm for lm in landmarks if lm["type"] == "stairs"]
    ramps = [lm for lm in landmarks if lm["type"] == "ramp"]
    elevators = [lm for lm in landmarks if lm["type"] == "elevator"]

    # --------------------------------------------------
    # 3. Place doors + rooms
    # --------------------------------------------------
    # Doors on left wall of image (center_y < 0.5) → above corridor
    # Doors on right wall (center_y >= 0.5) → below corridor
    # Doors sorted by depth (center_x) for deterministic placement
    sorted_doors = sorted(doors, key=lambda d: d["center_x"])

    # Track used x-positions to avoid overlap
    used_positions: list[tuple[float, str]] = []  # (x, side)

    for door in sorted_doors:
        cx = door["center_x"]
        cy = door["center_y"]

        # Determine side from image vertical position
        side = "above" if cy < 0.5 else "below"

        # Map depth to corridor x
        door_x = _map_x_to_corridor(cx) - DOOR_W // 2
        door_x = _clamp(door_x, CORRIDOR_X + 10, CORRIDOR_X + CORRIDOR_W - DOOR_W - 10)

        # Avoid overlap with existing elements on same side
        for used_x, used_side in used_positions:
            if used_side == side and abs(door_x - used_x) < DOOR_W + 20:
                # Shift slightly to avoid collision
                door_x = used_x + DOOR_W + 25
                door_x = _clamp(door_x, CORRIDOR_X + 10, CORRIDOR_X + CORRIDOR_W - DOOR_W - 10)

        used_positions.append((door_x, side))

        # Door on corridor wall
        if side == "above":
            door_y = CORRIDOR_Y - DOOR_H
        else:
            door_y = CORRIDOR_Y + CORRIDOR_H

        door_id = _fp_id("door")
        elements.append({
            "id": door_id,
            "type": "door",
            "x": round(door_x),
            "y": round(door_y),
            "width": DOOR_W,
            "height": DOOR_H,
            "confidence": round(door["confidence"], 3),
            "wheelchair_accessible": True,
        })

        # Room behind the door
        room_id = _fp_id("room")
        if side == "above":
            room_y = door_y - ROOM_GAP - ROOM_H
        else:
            room_y = door_y + DOOR_H + ROOM_GAP

        elements.append({
            "id": room_id,
            "type": "room",
            "x": round(door_x - (ROOM_W - DOOR_W) // 2),
            "y": round(room_y),
            "width": ROOM_W,
            "height": ROOM_H,
            "estimated": True,
            "confidence": round(door["confidence"] * 0.7, 3),
            "connected_door_id": door_id,
        })

    # --------------------------------------------------
    # 4. Place exits
    # --------------------------------------------------
    #   - Exit at far right of image (center_x > 0.6)
    #     → at RIGHT END of corridor (end-of-hallway exit)
    #   - Exit sign on wall (center_x <= 0.6)
    #     → on the wall side (above/below corridor)
    for ex in exits:
        ex_id = _fp_id("exit")
        cx = ex["center_x"]
        cy = ex["center_y"]

        if cx > 0.6:
            # End-of-hallway exit → right end of corridor, outside
            ex_x = CORRIDOR_X + CORRIDOR_W + 5
            ex_y = CORRIDOR_Y + CORRIDOR_H // 2 - EXIT_SIZE // 2
        elif cy < 0.5:
            # Side exit on left wall → above corridor
            ex_x = _map_x_to_corridor(cx) - EXIT_SIZE // 2
            ex_y = CORRIDOR_Y - EXIT_SIZE - 10
        else:
            # Side exit on right wall → below corridor
            ex_x = _map_x_to_corridor(cx) - EXIT_SIZE // 2
            ex_y = CORRIDOR_Y + CORRIDOR_H + 10

        ex_x = _clamp(ex_x, 10, CORRIDOR_X + CORRIDOR_W + 30)

        elements.append({
            "id": ex_id,
            "type": "exit",
            "x": round(ex_x),
            "y": round(ex_y),
            "width": EXIT_SIZE,
            "height": EXIT_SIZE,
            "confidence": round(ex["confidence"], 3),
            "wheelchair_accessible": True,
        })

    # Default exit at corridor start if none detected
    if not exits:
        elements.append({
            "id": _fp_id("exit"),
            "type": "exit",
            "x": CORRIDOR_X - EXIT_SIZE - 5,
            "y": CORRIDOR_Y + CORRIDOR_H // 2 - EXIT_SIZE // 2,
            "width": EXIT_SIZE,
            "height": EXIT_SIZE,
            "confidence": 0.1,
            "wheelchair_accessible": True,
        })

    # --------------------------------------------------
    # 5. Place stairs / ramps / elevators
    # --------------------------------------------------
    verticals = stairs_list + ramps + elevators
    for v in verticals:
        v_id = _fp_id(v["type"])
        cx = v["center_x"]
        cy = v["center_y"]

        v_x = _map_x_to_corridor(cx) - STAIRS_W // 2
        if cy < 0.5:
            v_y = CORRIDOR_Y - STAIRS_H - 15
        else:
            v_y = CORRIDOR_Y + CORRIDOR_H + 15

        v_x = _clamp(v_x, CORRIDOR_X, CORRIDOR_X + CORRIDOR_W - STAIRS_W)

        elements.append({
            "id": v_id,
            "type": v["type"],
            "x": round(v_x),
            "y": round(v_y),
            "width": STAIRS_W,
            "height": STAIRS_H,
            "confidence": round(v["confidence"], 3),
            "wheelchair_accessible": v["wheelchair_accessible"],
        })

    # --------------------------------------------------
    # 6. Ensure minimum viable floor plan
    # --------------------------------------------------
    if len(elements) <= 1:
        # Only corridor — add placeholder elements
        for i, x_frac in enumerate([0.15, 0.35, 0.55]):
            side = "above" if i % 2 == 0 else "below"
            door_id = _fp_id("door")
            dx = _map_x_to_corridor(x_frac) - DOOR_W // 2
            if side == "above":
                dy = CORRIDOR_Y - DOOR_H
            else:
                dy = CORRIDOR_Y + CORRIDOR_H

            elements.append({
                "id": door_id, "type": "door",
                "x": round(dx), "y": round(dy),
                "width": DOOR_W, "height": DOOR_H,
                "confidence": 0.15, "wheelchair_accessible": True,
            })
            room_id = _fp_id("room")
            ry = (dy - ROOM_GAP - ROOM_H) if side == "above" else (dy + DOOR_H + ROOM_GAP)
            elements.append({
                "id": room_id, "type": "room",
                "x": round(dx - (ROOM_W - DOOR_W) // 2), "y": round(ry),
                "width": ROOM_W, "height": ROOM_H,
                "estimated": True, "confidence": 0.1,
                "connected_door_id": door_id,
            })

        # Default exit at corridor end
        elements.append({
            "id": _fp_id("exit"), "type": "exit",
            "x": CORRIDOR_X + CORRIDOR_W + 5,
            "y": CORRIDOR_Y + CORRIDOR_H // 2 - EXIT_SIZE // 2,
            "width": EXIT_SIZE, "height": EXIT_SIZE,
            "confidence": 0.1, "wheelchair_accessible": True,
        })

    logger.info("[AI] Floor plan: %d elements generated", len(elements))

    return {
        "width": FP_WIDTH,
        "height": FP_HEIGHT,
        "units": "relative",
        "approximate": True,
        "elements": elements,
    }
