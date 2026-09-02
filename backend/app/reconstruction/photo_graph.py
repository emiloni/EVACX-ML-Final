"""Photo connectivity graph.

Builds a graph where:
- NODE = photo (with features and metadata)
- EDGE = confirmed visual overlap (with geometric transform)

Used to understand spatial relationships between photos.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field

import networkx as nx
import numpy as np

from app.reconstruction.overlap_detector import OverlapResult
from app.reconstruction.image_features import ImageFeatures

logger = logging.getLogger(__name__)


@dataclass
class PhotoNode:
    """A photo in the connectivity graph."""
    image_id: str
    index: int
    width: int = 0
    height: int = 0
    num_features: int = 0


@dataclass
class OverlapEdge:
    """A confirmed overlap between two photos."""
    image_a: str
    image_b: str
    overlap_score: float
    inlier_count: int
    homography: np.ndarray | None = None


@dataclass
class PhotoGraph:
    """Connectivity graph for a set of photos."""
    nodes: dict[str, PhotoNode] = field(default_factory=dict)
    edges: list[OverlapEdge] = field(default_factory=list)
    groups: list[list[str]] = field(default_factory=list)

    @property
    def num_photos(self) -> int:
        return len(self.nodes)

    @property
    def num_edges(self) -> int:
        return len(self.edges)

    @property
    def num_groups(self) -> int:
        return len(self.groups)


def build_photo_graph(
    features: list[ImageFeatures],
    overlaps: list[OverlapResult],
) -> PhotoGraph:
    """Build photo connectivity graph from features and overlaps.

    Parameters
    ----------
    features : extracted features for each image.
    overlaps : pairwise overlap results.

    Returns
    -------
    PhotoGraph with nodes, edges, and connected groups.
    """
    graph = PhotoGraph()

    # Add nodes
    for i, feat in enumerate(features):
        node = PhotoNode(
            image_id=feat.image_id,
            index=i,
            width=feat.width,
            height=feat.height,
            num_features=feat.num_keypoints,
        )
        graph.nodes[feat.image_id] = node

    # Add edges (confirmed + possible overlaps)
    for overlap in overlaps:
        status = getattr(overlap, 'status', 'rejected')
        if status in ('confirmed', 'possible'):
            score = getattr(overlap, 'combined_score', getattr(overlap, 'overlap_score', 0))
            edge = OverlapEdge(
                image_a=overlap.image_a,
                image_b=overlap.image_b,
                overlap_score=score,
                inlier_count=overlap.geometric_inliers,
                homography=overlap.homography,
            )
            graph.edges.append(edge)

    # Find connected groups using Union-Find
    parent: dict[str, str] = {n: n for n in graph.nodes}

    def find(x: str) -> str:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(x: str, y: str) -> None:
        rx, ry = find(x), find(y)
        if rx != ry:
            parent[rx] = ry

    for edge in graph.edges:
        union(edge.image_a, edge.image_b)

    # Group photos by connected component
    groups_map: dict[str, list[str]] = {}
    for node_id in graph.nodes:
        root = find(node_id)
        groups_map.setdefault(root, []).append(node_id)

    graph.groups = list(groups_map.values())

    # Report disconnected groups
    if len(graph.groups) > 1:
        logger.warning(
            "[GRAPH] %d disconnected photo groups detected",
            len(graph.groups),
        )
        for i, group in enumerate(graph.groups):
            logger.warning(
                "[GRAPH]   Group %d: %s", i, group,
            )

    logger.info(
        "[GRAPH] %d photos, %d edges, %d groups",
        graph.num_photos, graph.num_edges, graph.num_groups,
    )

    return graph
