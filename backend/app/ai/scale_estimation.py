"""Scale estimation for the reconstructed floor plan.

Three modes:

1. **User-provided reference** — the user gives one real-world
   measurement (e.g. door width = 0.9 m).  We use it as a local
   scale anchor.

2. **Standard object estimation** — if no reference is given, we
   use typical dimensions (door ≈ 0.9 m) and mark all sizes as
   *estimated*.

3. **Relative scale** — if even standard estimation is unreliable,
   we produce proportional-only dimensions.
"""

from __future__ import annotations

import logging
from typing import Optional

from app.models.building_models import ConfidenceSource, ScaleMode
from app.models.detection_models import (
    EvacClass,
    PhotoAnalysis,
    ReferenceMeasurement,
    ReferenceType,
)

logger = logging.getLogger(__name__)

# Typical real-world widths in metres
TYPICAL_WIDTHS: dict[EvacClass, float] = {
    EvacClass.DOOR: 0.9,
    EvacClass.EXIT_DOOR: 1.0,
    EvacClass.EMERGENCY_EXIT: 1.0,
    EvacClass.STAIRS: 1.2,
    EvacClass.ELEVATOR: 1.1,
    EvacClass.RAMP: 1.2,
    EvacClass.CORRIDOR: 2.0,
}

# Mapping from ReferenceType → EvacClass for user references
REF_TYPE_TO_EVAC: dict[ReferenceType, EvacClass] = {
    ReferenceType.DOOR_WIDTH: EvacClass.DOOR,
    ReferenceType.CORRIDOR_WIDTH: EvacClass.CORRIDOR,
    ReferenceType.ENTRANCE_WIDTH: EvacClass.EXIT_DOOR,
    ReferenceType.STAIR_WIDTH: EvacClass.STAIRS,
    ReferenceType.FLOOR_HEIGHT: EvacClass.STAIRS,
    ReferenceType.CUSTOM: EvacClass.DOOR,
}


class ScaleEstimate:
    """Holds the computed scale information for a set of photos."""

    def __init__(
        self,
        mode: ScaleMode,
        pixels_per_meter: Optional[float],
        reference_meters: Optional[float],
        reference_class: Optional[EvacClass],
        confidence: float,
        confidence_source: ConfidenceSource,
    ):
        self.mode = mode
        self.pixels_per_meter = pixels_per_meter
        self.reference_meters = reference_meters
        self.reference_class = reference_class
        self.confidence = confidence
        self.confidence_source = confidence_source

    def pixels_to_meters(self, px: float) -> float:
        if self.pixels_per_meter and self.pixels_per_meter > 0:
            return px / self.pixels_per_meter
        return px  # fallback: pixel units

    def to_dict(self) -> dict:
        return {
            "mode": self.mode.value,
            "pixels_per_meter": (
                round(self.pixels_per_meter, 2)
                if self.pixels_per_meter
                else None
            ),
            "confidence": round(self.confidence, 2),
            "confidence_source": self.confidence_source.value,
        }


def _find_reference_detections(
    analyses: list[PhotoAnalysis],
    target_class: EvacClass,
) -> list:
    """Find detections of a specific class across all photos."""
    results = []
    for a in analyses:
        for d in a.detections:
            if d.evac_class == target_class and d.confidence >= 0.10:
                results.append(d)
    return results


def _estimate_scale_from_detections(
    analyses: list[PhotoAnalysis],
    target_class: EvacClass,
    real_meters: float,
) -> Optional[float]:
    """Compute pixels-per-metre from detection pixel widths."""
    dets = _find_reference_detections(analyses, target_class)
    if not dets:
        return None

    avg_px = sum(d.bounding_box.width for d in dets) / len(dets)
    if avg_px <= 0:
        return None

    ppm = avg_px / real_meters
    logger.info(
        "Scale anchor: %s avg %.0f px → %.2f m  →  %.1f px/m",
        target_class.value,
        avg_px,
        real_meters,
        ppm,
    )
    return ppm


def estimate_scale(
    analyses: list[PhotoAnalysis],
    reference: Optional[ReferenceMeasurement] = None,
) -> ScaleEstimate:
    """Determine the best available scale for the floor plan."""

    # --- Mode 1: user-provided reference ---
    if reference is not None:
        target_class = REF_TYPE_TO_EVAC.get(
            reference.reference_type, EvacClass.DOOR
        )
        ppm = _estimate_scale_from_detections(
            analyses, target_class, reference.value
        )
        if ppm is not None:
            return ScaleEstimate(
                mode=ScaleMode.USER_REFERENCE,
                pixels_per_meter=ppm,
                reference_meters=reference.value,
                reference_class=target_class,
                confidence=0.75,
                confidence_source=ConfidenceSource.USER_PROVIDED,
            )

    # --- Mode 2: standard object estimation ---
    for ev_class in (EvacClass.DOOR, EvacClass.CORRIDOR, EvacClass.STAIRS):
        typ = TYPICAL_WIDTHS.get(ev_class)
        if typ is None:
            continue
        ppm = _estimate_scale_from_detections(analyses, ev_class, typ)
        if ppm is not None:
            return ScaleEstimate(
                mode=ScaleMode.STANDARD_OBJECT,
                pixels_per_meter=ppm,
                reference_meters=typ,
                reference_class=ev_class,
                confidence=0.45,
                confidence_source=ConfidenceSource.STANDARD_DIMENSION,
            )

    # --- Mode 3: relative scale ---
    return ScaleEstimate(
        mode=ScaleMode.RELATIVE,
        pixels_per_meter=None,
        reference_meters=None,
        reference_class=None,
        confidence=0.25,
        confidence_source=ConfidenceSource.RELATIVE_SIZE_ESTIMATION,
    )
