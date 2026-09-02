"""Navigation skeleton builder.

Converts spatial landmarks + inferred edges into a simplified
navigation graph (nodes + edges) suitable for floor-plan layout
and subsequent routing.
"""

from __future__ import annotations

import logging
import uuid

from app.models.building_models import (
    BuildingEdge,
    BuildingNode,
    ConfidenceSource,
    LandmarkType,
    NavigationGraph,
    RoomEstimate,
    SpatialLandmark,
)
from app.models.detection_models import EvacClass, PhotoAnalysis

logger = logging.getLogger(__name__)

# Evac classes that map directly to navigation nodes
_LANDMARK_TO_NODE_TYPE: dict[LandmarkType, LandmarkType] = {
    LandmarkType.DOOR: LandmarkType.DOOR,
    LandmarkType.EXIT: LandmarkType.EXIT,
    LandmarkType.STAIRS: LandmarkType.STAIRS,
    LandmarkType.RAMP: LandmarkType.RAMP,
    LandmarkType.ELEVATOR: LandmarkType.ELEVATOR,
    LandmarkType.CORRIDOR: LandmarkType.CORRIDOR,
    LandmarkType.JUNCTION: LandmarkType.JUNCTION,
    LandmarkType.ENTRANCE: LandmarkType.ENTRANCE,
    LandmarkType.FIRE_EXTINGUISHER: LandmarkType.FIRE_EXTINGUISHER,
}


def _make_node(
    landmark: SpatialLandmark,
    x: float,
    y: float,
    label: str | None = None,
) -> BuildingNode:
    ntype = _LANDMARK_TO_NODE_TYPE.get(landmark.type, landmark.type)
    return BuildingNode(
        id=landmark.id,
        type=ntype,
        x=x,
        y=y,
        floor=1,
        confidence=landmark.confidence,
        confidence_source=landmark.confidence_source,
        wheelchair_accessible=landmark.wheelchair_accessible,
        label=label,
    )


def build_navigation_skeleton(
    landmarks: list[SpatialLandmark],
    edge_models: list[BuildingEdge],
    analyses: list[PhotoAnalysis],
    scale_ppm: float | None = None,
) -> NavigationGraph:
    """Build a navigation skeleton from landmarks and edges.

    This places nodes in a simple 1-D sequence along the photo order,
    then attaches doors/stairs/etc. to their parent corridor.
    """
    nodes: list[BuildingNode] = []
    node_map: dict[str, BuildingNode] = {}

    # -- Place corridor nodes sequentially along x-axis --
    corridor_spacing = 10.0  # meters between corridor segments
    corridors = sorted(
        [lm for lm in landmarks if lm.type == LandmarkType.CORRIDOR],
        key=lambda l: l.photo_index,
    )

    for i, lm in enumerate(corridors):
        x = i * corridor_spacing
        y = 0.0
        node = _make_node(lm, x, y, label=f"Corridor {i + 1}")
        nodes.append(node)
        node_map[lm.id] = node

    # -- Place architectural elements --
    door_offset = 3.0  # meters off corridor centerline
    for lm in landmarks:
        if lm.id in node_map:
            continue  # already placed
        if lm.type == LandmarkType.CORRIDOR:
            continue

        # Find the closest corridor by photo index
        parent_corr = None
        min_dist = float("inf")
        for c in corridors:
            d = abs(c.photo_index - lm.photo_index)
            if d < min_dist:
                min_dist = d
                parent_corr = c

        if parent_corr and parent_corr.id in node_map:
            parent_node = node_map[parent_corr.id]
            # Alternate sides: doors on left, stairs/ramps on right
            side = -1 if lm.type == LandmarkType.DOOR else 1
            if lm.relative_position and "left" in lm.relative_position:
                side = -1
            elif lm.relative_position and "right" in lm.relative_position:
                side = 1

            x = parent_node.x + (min_dist * 1.5)
            y = parent_node.y + side * door_offset
        else:
            x = len(corridors) * corridor_spacing
            y = 0.0

        label_map = {
            LandmarkType.DOOR: "Door",
            LandmarkType.EXIT: "Exit",
            LandmarkType.STAIRS: "Stairs",
            LandmarkType.RAMP: "Ramp",
            LandmarkType.ELEVATOR: "Elevator",
            LandmarkType.ENTRANCE: "Entrance",
            LandmarkType.FIRE_EXTINGUISHER: "Extinguisher",
        }
        label = f"{label_map.get(lm.type, lm.type.value)} (P{lm.photo_index + 1})"

        node = _make_node(lm, x, y, label=label)
        nodes.append(node)
        node_map[lm.id] = node

    # -- Convert edge models to building edges (keeping original format) --
    nav_edges: list[BuildingEdge] = []
    for em in edge_models:
        if em.source in node_map and em.target in node_map:
            nav_edges.append(em)

    # -- Connect corridor chain if not already connected --
    corridor_ids = [c.id for c in corridors if c.id in node_map]
    for i in range(len(corridor_ids) - 1):
        key = tuple(sorted([corridor_ids[i], corridor_ids[i + 1]]))
        already = any(
            tuple(sorted([e.source, e.target])) == key
            for e in nav_edges
        )
        if not already:
            nav_edges.append(
                BuildingEdge(
                    source=corridor_ids[i],
                    target=corridor_ids[i + 1],
                    distance=corridor_spacing,
                    confidence=0.5,
                )
            )

    # -- Connect architectural elements to nearest corridor --
    for n in nodes:
        if n.type == LandmarkType.CORRIDOR:
            continue
        key_any = any(
            n.id in (e.source, e.target)
            for e in nav_edges
        )
        if not key_any:
            # find nearest corridor node
            nearest = None
            nd = float("inf")
            for cn in nodes:
                if cn.type == LandmarkType.CORRIDOR:
                    d = ((n.x - cn.x) ** 2 + (n.y - cn.y) ** 2) ** 0.5
                    if d < nd:
                        nd = d
                        nearest = cn
            if nearest:
                nav_edges.append(
                    BuildingEdge(
                        source=nearest.id,
                        target=n.id,
                        distance=max(nd, 0.5),
                        confidence=0.4,
                        stairs=n.type == LandmarkType.STAIRS,
                        wheelchair_accessible=n.wheelchair_accessible,
                    )
                )

    logger.info(
        "Navigation skeleton: %d nodes, %d edges",
        len(nodes),
        len(nav_edges),
    )

    return NavigationGraph(nodes=nodes, edges=nav_edges)
