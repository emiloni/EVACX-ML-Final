"""Photo analysis — runs YOLO-World on each uploaded photo.

Reuses the existing ``EnvironmentDetector`` from ``app.ai.detector``
so the YOLO-World model is loaded once and shared.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from app.models.detection_models import (
    BoundingBox,
    DetectedObject,
    EvacClass,
    PhotoAnalysis,
    YOLO_TO_EVAC,
)

if TYPE_CHECKING:
    import numpy as np


def _relative_position(
    cx: float, cy: float, w: int, h: int
) -> str:
    """Map a centre point to a coarse relative region."""
    nx = cx / w if w else 0.5
    ny = cy / h if h else 0.5

    horizontal = (
        "left" if nx < 0.33 else "right" if nx > 0.67 else "center"
    )
    vertical = (
        "top" if ny < 0.33 else "bottom" if ny > 0.67 else "middle"
    )
    return f"{horizontal}_{vertical}"


def analyze_photo(
    image_np: "np.ndarray",
    photo_index: int,
    filename: str,
    detector,
) -> PhotoAnalysis:
    """Run YOLO-World on *image_np* and return structured detections.

    Parameters
    ----------
    image_np:
        RGB numpy array from the uploaded image.
    photo_index:
        Sequential index of this photo in the capture order.
    filename:
        Original filename for traceability.
    detector:
        An ``EnvironmentDetector`` instance (shared, already loaded).
    """
    raw = detector.analyze(image_np)

    h, w = image_np.shape[:2]

    detections: list[DetectedObject] = []

    for d in raw:
        bbox_list = d["bbox"]
        bbox = BoundingBox(
            x1=float(bbox_list[0]),
            y1=float(bbox_list[1]),
            x2=float(bbox_list[2]),
            y2=float(bbox_list[3]),
        )

        evac_class = YOLO_TO_EVAC.get(
            d["type"], EvacClass.DOOR
        )

        det = DetectedObject(
            photo_index=photo_index,
            class_name=d["type"],
            evac_class=evac_class,
            confidence=d["confidence"],
            bounding_box=bbox,
            center_x=bbox.center_x,
            center_y=bbox.center_y,
            relative_position=_relative_position(
                bbox.center_x, bbox.center_y, w, h
            ),
        )
        detections.append(det)

    useful = len(detections) > 0

    return PhotoAnalysis(
        photo_index=photo_index,
        filename=filename,
        detections=detections,
        image_width=w,
        image_height=h,
        has_useful_detections=useful,
    )
