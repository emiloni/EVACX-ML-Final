"""Photo overlap detection using ORB feature matching.

Compares consecutive photos to estimate whether they share
visual content (same corridor section, overlapping view, etc.).

This improves connectivity inference for the spatial model.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from app.models.building_models import PhotoOverlap

if TYPE_CHECKING:
    import numpy as np

logger = logging.getLogger(__name__)

# -- ORB parameters --
MAX_FEATURES = 500
MATCH_RATIO_THRESHOLD = 0.15  # good matches / total features
OVERLAP_SCORE_THRESHOLD = 0.30  # below → sequence-only fallback
BF_NORM = 2  # cv2.NORM_HAMMING


def _compute_orb_features(
    gray: "np.ndarray",
    orb,
) -> tuple:
    """Detect ORB keypoints and descriptors."""
    kp, des = orb.detectAndCompute(gray, None)
    return kp, des


def estimate_overlap(
    img_a: "np.ndarray",
    img_b: "np.ndarray",
    photo_a: int,
    photo_b: int,
) -> PhotoOverlap:
    """Estimate visual overlap between two consecutive images.

    Returns a ``PhotoOverlap`` with a normalised ``overlap_score``
    between 0 and 1.  A score above ``OVERLAP_SCORE_THRESHOLD``
    means the images likely share content.
    """
    try:
        import cv2
    except ImportError:
        logger.warning("OpenCV not installed; returning sequence-only overlap")
        return PhotoOverlap(
            photo_a=photo_a,
            photo_b=photo_b,
            overlap_score=0.0,
            relationship="sequence_only",
        )

    # Convert to grayscale
    gray_a = (
        cv2.cvtColor(img_a, cv2.COLOR_RGB2GRAY)
        if len(img_a.shape) == 3
        else img_a
    )
    gray_b = (
        cv2.cvtColor(img_b, cv2.COLOR_RGB2GRAY)
        if len(img_b.shape) == 3
        else img_b
    )

    orb = cv2.ORB_create(nfeatures=MAX_FEATURES)
    kp_a, des_a = _compute_orb_features(gray_a, orb)
    kp_b, des_b = _compute_orb_features(gray_b, orb)

    if des_a is None or des_b is None or len(kp_a) < 10 or len(kp_b) < 10:
        return PhotoOverlap(
            photo_a=photo_a,
            photo_b=photo_b,
            overlap_score=0.0,
            relationship="sequence_only",
        )

    bf = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=False)
    matches = bf.knnMatch(des_a, des_b, k=2)

    # Lowe's ratio test
    good = []
    for m_list in matches:
        if len(m_list) == 2:
            m, n = m_list
            if m.distance < 0.75 * n.distance:
                good.append(m)

    total = min(len(kp_a), len(kp_b))
    if total == 0:
        ratio = 0.0
    else:
        ratio = len(good) / total

    score = min(ratio / MATCH_RATIO_THRESHOLD, 1.0)

    if score >= OVERLAP_SCORE_THRESHOLD:
        relationship = "likely_connected"
    else:
        relationship = "sequence_only"

    return PhotoOverlap(
        photo_a=photo_a,
        photo_b=photo_b,
        overlap_score=round(score, 3),
        relationship=relationship,
    )


def detect_sequential_overlaps(
    images: list["np.ndarray"],
) -> list[PhotoOverlap]:
    """Compare each consecutive pair and return overlap info."""
    results: list[PhotoOverlap] = []

    for i in range(len(images) - 1):
        ov = estimate_overlap(images[i], images[i + 1], i, i + 1)
        results.append(ov)

    return results
