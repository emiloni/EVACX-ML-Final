"""Photo-based building reconstruction pipeline.

Orchestrates the full workflow:

    Photos → YOLO detection → overlap → spatial mapping
    → navigation skeleton → floor plan → routing graph adapter
"""

from __future__ import annotations

import logging
from typing import Optional

import numpy as np

from app.ai.detection import analyze_photo
from app.ai.floorplan import build_navigation_skeleton
from app.ai.floorplan_generator import generate_floor_plan
from app.ai.overlap import detect_sequential_overlaps
from app.ai.scale_estimation import estimate_scale
from app.ai.spatial_mapping import build_landmarks_and_edges
from app.models.building_models import (
    ConfidenceSource,
    FloorPlan,
    LandmarkType,
    NavigationGraph,
    PhotoOverlap,
    ScaleMode,
    SpatialLandmark,
)
from app.models.detection_models import PhotoAnalysis, ReferenceMeasurement
from app.routing.graph_adapter import adapt_to_routing_format, adapt_to_routing_graph

logger = logging.getLogger(__name__)


class PhotoReconstructionResult:
    """Complete output of the photo reconstruction pipeline."""

    def __init__(
        self,
        success: bool,
        analyses: list[PhotoAnalysis],
        overlaps: list[PhotoOverlap],
        scale_info: dict,
        floor_plan: FloorPlan,
        navigation_graph: NavigationGraph,
        routing_graph_dict: dict,
        error: Optional[str] = None,
    ):
        self.success = success
        self.analyses = analyses
        self.overlaps = overlaps
        self.scale_info = scale_info
        self.floor_plan = floor_plan
        self.navigation_graph = navigation_graph
        self.routing_graph_dict = routing_graph_dict
        self.error = error

    def to_response(self) -> dict:
        """Build the API response payload."""
        total_detections = sum(
            len(a.detections) for a in self.analyses
        )
        connected_overlaps = sum(
            1 for o in self.overlaps
            if o.relationship == "likely_connected"
        )

        # Overall confidence: weighted average from scale + detection
        confs = []
        for a in self.analyses:
            for d in a.detections:
                confs.append(d.confidence)
        avg_det_conf = (sum(confs) / len(confs)) if confs else 0.0
        overall_conf = (
            avg_det_conf * 0.5
            + self.scale_info.get("confidence", 0) * 0.5
        )

        return {
            "success": self.success,
            "error": self.error,
            "analysis": {
                "photos_processed": len(self.analyses),
                "detections": total_detections,
                "overlap_relationships": connected_overlaps,
            },
            "floor_plan": {
                "floor": self.floor_plan.floor,
                "elements": [e.model_dump(mode="json") for e in self.floor_plan.elements],
                "rooms": [r.model_dump(mode="json") for r in self.floor_plan.rooms],
            },
            "navigation_graph": {
                "nodes": [n.model_dump(mode="json") for n in self.navigation_graph.nodes],
                "edges": [e.model_dump(mode="json") for e in self.navigation_graph.edges],
            },
            "routing_graph": self.routing_graph_dict,
            "metadata": {
                "scale_mode": self.scale_info.get("mode", "relative"),
                "scale_info": self.scale_info,
                "approximate": True,
                "overall_confidence": round(overall_conf, 2),
                "warning": (
                    "This floor plan is an AI-generated approximation. "
                    "Please review and correct it before relying on it."
                ),
            },
        }


def run_photo_pipeline(
    images: list[np.ndarray],
    filenames: list[str],
    reference: Optional[ReferenceMeasurement] = None,
    detector=None,
    floor: int = 1,
) -> PhotoReconstructionResult:
    """Execute the full photo-based building reconstruction pipeline.

    Parameters
    ----------
    images : list of RGB numpy arrays, in capture order.
    filenames : original filenames for each photo.
    reference : optional user-provided measurement.
    detector : shared ``EnvironmentDetector`` instance.
    floor : floor number.

    Returns
    -------
    PhotoReconstructionResult
    """
    # -- Fallback: if nothing useful, return partial result --
    if not images:
        return PhotoReconstructionResult(
            success=False,
            analyses=[],
            overlaps=[],
            scale_info={},
            floor_plan=FloorPlan(),
            navigation_graph=NavigationGraph(),
            routing_graph_dict={},
            error="No images provided.",
        )

    # Step 1: Run YOLO-World on each photo
    analyses: list[PhotoAnalysis] = []
    for i, (img, fn) in enumerate(zip(images, filenames)):
        try:
            analysis = analyze_photo(img, i, fn, detector)
            analyses.append(analysis)
        except Exception as exc:
            logger.warning("Photo %d analysis failed: %s", i, exc)
            analyses.append(
                PhotoAnalysis(
                    photo_index=i,
                    filename=fn,
                    image_width=img.shape[1] if len(img.shape) >= 2 else 0,
                    image_height=img.shape[0] if len(img.shape) >= 2 else 0,
                    has_useful_detections=False,
                )
            )

    # Step 2: Detect photo overlaps
    overlaps = detect_sequential_overlaps(images)

    # Step 3: Scale estimation
    scale = estimate_scale(analyses, reference)

    # Step 4: Spatial mapping → landmarks + edges
    landmarks, edge_models = build_landmarks_and_edges(analyses, overlaps)

    # Safety net: if landmarks is still empty (shouldn't happen
    # now that infer_corridor_segments always returns segments),
    # create one corridor per photo as last resort.
    if not landmarks:
        for a in analyses:
            landmarks.append(
                SpatialLandmark(
                    type=LandmarkType.CORRIDOR,
                    photo_index=a.photo_index,
                    relative_position="center",
                    confidence=0.15,
                    confidence_source=ConfidenceSource.INFERRED_FROM_SEQUENCE,
                )
            )

    # Ensure at least one exit landmark exists so the
    # routing engine always has a destination to route to.
    has_exit = any(lm.type == LandmarkType.EXIT for lm in landmarks)
    if not has_exit and landmarks:
        last_photo_idx = max(lm.photo_index for lm in landmarks)
        landmarks.append(
            SpatialLandmark(
                type=LandmarkType.EXIT,
                photo_index=last_photo_idx,
                relative_position="right_center",
                confidence=0.2,
                confidence_source=ConfidenceSource.INFERRED_FROM_SEQUENCE,
            )
        )

    # Step 5: Build navigation skeleton
    nav_graph = build_navigation_skeleton(
        landmarks, edge_models, analyses, scale.pixels_per_meter
    )

    # Step 6: Generate 2-D floor plan
    floor_plan = generate_floor_plan(nav_graph, scale.mode)

    # Step 7: Adapt to routing graph
    routing_nx = adapt_to_routing_graph(nav_graph)
    routing_dict = adapt_to_routing_format(routing_nx)

    return PhotoReconstructionResult(
        success=True,
        analyses=analyses,
        overlaps=overlaps,
        scale_info=scale.to_dict(),
        floor_plan=floor_plan,
        navigation_graph=nav_graph,
        routing_graph_dict=routing_dict,
    )
