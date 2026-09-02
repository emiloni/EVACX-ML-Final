"""Graph adapter — bridges photo-reconstructed graph to existing routing.

The existing ``app.graph.routing.calculate_route`` expects a
``networkx.Graph`` whose nodes have ``type``, ``x``, ``y``,
``confidence``, ``hazard``, ``congestion``, and ``wheelchair_accessible``
attributes, and whose edges have ``distance``, ``hazard``,
``congestion``, ``blocked``, and ``stairs`` attributes.

This module converts our ``NavigationGraph`` (Pydantic models) into
that exact NetworkX format.
"""

from __future__ import annotations

import logging
import math

import networkx as nx

from app.models.building_models import (
    BuildingEdge,
    BuildingNode,
    LandmarkType,
    NavigationGraph,
)

logger = logging.getLogger(__name__)

# The routing engine always looks for a node called "start"
_ROUTING_START_ID = "start"


def adapt_to_routing_graph(
    nav_graph: NavigationGraph,
) -> nx.Graph:
    """Convert a ``NavigationGraph`` into a NetworkX graph for routing.

    The first corridor node (or first node overall) is designated as
    the ``start`` node so that ``calculate_route`` can find it.
    """
    graph = nx.Graph()

    # --- Add nodes ---
    for n in nav_graph.nodes:
        graph.add_node(
            n.id,
            type=n.type.value,
            label=n.label or n.type.value.upper(),
            x=n.x,
            y=n.y,
            confidence=n.confidence,
            hazard=0.0,
            congestion=0.0,
            wheelchair_accessible=n.wheelchair_accessible,
        )

    # --- Designate a start node ---
    # Prefer the first corridor; fall back to the first node.
    start_candidate = None
    for n in nav_graph.nodes:
        if n.type == LandmarkType.CORRIDOR:
            start_candidate = n.id
            break
    if start_candidate is None and nav_graph.nodes:
        start_candidate = nav_graph.nodes[0].id

    if start_candidate:
        if _ROUTING_START_ID not in graph:
            # Copy the original node as "start"
            data = dict(graph.nodes[start_candidate])
            graph.add_node(_ROUTING_START_ID, **data)

            # Connect start to its original position
            orig_data = graph.nodes[start_candidate]
            dx = orig_data.get("x", 0)
            dy = orig_data.get("y", 0)
            dist = math.sqrt(dx ** 2 + dy ** 2) if dx or dy else 1.0
            graph.add_edge(
                _ROUTING_START_ID,
                start_candidate,
                distance=dist,
                hazard=0.0,
                congestion=0.0,
                blocked=False,
                stairs=False,
            )
        else:
            # "start" already exists; merge
            pass

    # --- Add edges ---
    for e in nav_graph.edges:
        if e.source not in graph:
            continue
        if e.target not in graph:
            continue
        graph.add_edge(
            e.source,
            e.target,
            distance=max(e.distance, 0.1),
            hazard=e.hazard,
            congestion=e.congestion,
            blocked=e.blocked,
            stairs=e.stairs,
        )

    logger.info(
        "Routing graph adapted: %d nodes, %d edges",
        graph.number_of_nodes(),
        graph.number_of_edges(),
    )

    return graph


def adapt_to_routing_format(
    graph: nx.Graph,
) -> dict:
    """Serialize a routing NetworkX graph to the JSON format
    expected by the frontend ``digital_twin`` display.
    """
    nodes = []
    for node_id, data in graph.nodes(data=True):
        nodes.append(
            {
                "id": node_id,
                "type": data.get("type"),
                "label": data.get("label"),
                "x": data.get("x", 0),
                "y": data.get("y", 0),
                "confidence": data.get("confidence", 1),
            }
        )

    edges = []
    for source, target, data in graph.edges(data=True):
        edges.append(
            {
                "source": source,
                "target": target,
                "distance": round(data.get("distance", 0), 2),
                "blocked": data.get("blocked", False),
            }
        )

    return {"nodes": nodes, "edges": edges}
