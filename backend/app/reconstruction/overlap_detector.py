"""Multi-stage overlap detection pipeline.

Architecture:
    STAGE A: Global image similarity (lightweight pre-filter)
    STAGE B: Local feature matching (ORB/AKAZE with ratio test)
    STAGE C: Geometric verification (RANSAC homography + inlier analysis)
    STAGE D: Landmark matching (shared detected objects)
    STAGE E: Spatial consistency (sequence order + camera geometry)
    STAGE F: Semantic consistency (class agreement)

    Combined score → CONFIRMED / POSSIBLE / REJECTED
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field

import cv2
import numpy as np

from app.reconstruction.image_features import ImageFeatures

logger = logging.getLogger(__name__)

# --- Configurable thresholds ---
CONFIRMED_THRESHOLD = 0.65
POSSIBLE_THRESHOLD = 0.40
RATIO_THRESHOLD = 0.75
RANSAC_REPROJECTED_DIST = 5.0
MIN_INLIERS = 10

# Feature detector fallback hierarchy
FEATURE_BACKEND = "orb"  # "sift", "akaze", or "orb"


def _create_detector():
    """Create feature detector with fallback hierarchy."""
    if FEATURE_BACKEND == "sift":
        try:
            return cv2.SIFT_create(nfeatures=3000)
        except AttributeError:
            pass
    if FEATURE_BACKEND == "akaze":
        try:
            return cv2.AKAZE_create()
        except AttributeError:
            pass
    return cv2.ORB_create(nfeatures=3000)


@dataclass
class OverlapResult:
    """Full pairwise overlap analysis result."""
    image_a: str
    image_b: str
    # Stage scores (0-1)
    global_score: float = 0.0
    feature_score: float = 0.0
    geometry_score: float = 0.0
    landmark_score: float = 0.0
    spatial_score: float = 0.0
    semantic_score: float = 0.0
    # Combined
    combined_score: float = 0.0
    status: str = "rejected"  # confirmed / possible / rejected
    # Details
    raw_matches: int = 0
    ratio_test_matches: int = 0
    geometric_inliers: int = 0
    inlier_ratio: float = 0.0
    homography: np.ndarray | None = None
    shared_landmarks: list[str] = field(default_factory=list)


# ============================================================
# STAGE A: Global image similarity
# ============================================================

def _global_similarity(img_a: np.ndarray, img_b: np.ndarray) -> float:
    """Lightweight global visual descriptor comparison.

    Uses colour histogram correlation + perceptual hash difference.
    This is fast and filters out obviously unrelated pairs.
    """
    # Resize for consistency
    size = (64, 64)
    try:
        a = cv2.resize(img_a, size)
        b = cv2.resize(img_b, size)
    except Exception:
        return 0.0

    # colour histogram correlation (HSV)
    hsv_a = cv2.cvtColor(a, cv2.COLOR_RGB2HSV)
    hsv_b = cv2.cvtColor(b, cv2.COLOR_RGB2HSV)

    hist_a = cv2.calcHist([hsv_a], [0, 1], None, [50, 60], [0, 180, 0, 256])
    hist_b = cv2.calcHist([hsv_b], [0, 1], None, [50, 60], [0, 180, 0, 256])
    cv2.normalize(hist_a, hist_a)
    cv2.normalize(hist_b, hist_b)

    corr = cv2.compareHist(hist_a, hist_b, cv2.HISTCMP_CORREL)

    # Structural similarity via grayscale MSE
    gray_a = cv2.cvtColor(a, cv2.COLOR_RGB2GRAY)
    gray_b = cv2.cvtColor(b, cv2.COLOR_RGB2GRAY)
    mse = np.mean((gray_a.astype(float) - gray_b.astype(float)) ** 2)
    structural = max(0.0, 1.0 - mse / 5000.0)

    score = 0.6 * max(0, corr) + 0.4 * structural
    return float(np.clip(score, 0, 1))


# ============================================================
# STAGE B: Local feature matching
# ============================================================

def _feature_matching(
    feat_a: ImageFeatures, feat_b: ImageFeatures,
) -> tuple[int, int, list]:
    """KNN matching with Lowe's ratio test.

    Returns (raw_count, good_count, good_matches).
    """
    if feat_a.descriptors is None or feat_b.descriptors is None:
        return 0, 0, []
    if len(feat_a.descriptors) < 2 or len(feat_b.descriptors) < 2:
        return 0, 0, []

    norm = cv2.NORM_HAMMING
    if FEATURE_BACKEND == "sift":
        norm = cv2.NORM_L2

    bf = cv2.BFMatcher(norm, crossCheck=False)
    try:
        raw = bf.knnMatch(feat_a.descriptors, feat_b.descriptors, k=2)
    except cv2.error:
        return 0, 0, []

    good = []
    for m_list in raw:
        if len(m_list) == 2:
            m, n = m_list
            if m.distance < RATIO_THRESHOLD * n.distance:
                good.append(m)

    return len(raw), len(good), good


def _compute_feature_score(
    raw_count: int, good_count: int,
    num_kp_a: int, num_kp_b: int,
) -> float:
    """Normalised feature match quality score."""
    if raw_count == 0:
        return 0.0
    ratio = good_count / max(raw_count, 1)
    coverage = good_count / max(min(num_kp_a, num_kp_b) * 0.3, 1)
    return float(np.clip(0.5 * ratio + 0.5 * min(coverage, 1.0), 0, 1))


# ============================================================
# STAGE C: Geometric verification
# ============================================================

def _geometric_verification(
    feat_a: ImageFeatures, feat_b: ImageFeatures,
    good_matches: list,
) -> tuple[float, int, float, np.ndarray | None]:
    """RANSAC homography estimation.

    Returns (inlier_ratio, inlier_count, geometry_score, H).
    """
    if len(good_matches) < MIN_INLIERS:
        return 0.0, 0, 0.0, None

    pts_a = np.float32([
        feat_a.keypoints[m.queryIdx].pt for m in good_matches
    ]).reshape(-1, 1, 2)
    pts_b = np.float32([
        feat_b.keypoints[m.trainIdx].pt for m in good_matches
    ]).reshape(-1, 1, 2)

    H, mask = cv2.findHomography(
        pts_a, pts_b, cv2.RANSAC,
        ransacReprojThreshold=RANSAC_REPROJECTED_DIST,
    )

    if H is None or mask is None:
        return 0.0, 0, 0.0, None

    inlier_count = int(mask.sum())
    inlier_ratio = inlier_count / len(good_matches) if good_matches else 0

    # Score based on inlier count and ratio
    count_score = min(inlier_count / 30.0, 1.0)
    ratio_score = min(inlier_ratio / 0.7, 1.0)
    geometry_score = float(np.clip(0.4 * count_score + 0.6 * ratio_score, 0, 1))

    return inlier_ratio, inlier_count, geometry_score, H


# ============================================================
# STAGE D: Landmark matching
# ============================================================

def _landmark_matching_score(
    landmarks_a: list[dict], landmarks_b: list[dict],
    image_sizes: dict[str, tuple[int, int]],
) -> tuple[float, list[str]]:
    """Compare detected landmarks between two images.

    Returns (landmark_score, shared_landmark_ids).
    """
    if not landmarks_a or not landmarks_b:
        return 0.0, []

    # Group by type for efficient comparison
    shared: list[str] = []

    for la in landmarks_a:
        for lb in landmarks_b:
            if la.get("type") != lb.get("type"):
                continue
            # Check spatial proximity in normalised coords
            bbox_a = la.get("bbox", [0, 0, 0, 0])
            bbox_b = lb.get("bbox", [0, 0, 0, 0])
            if len(bbox_a) < 4 or len(bbox_b) < 4:
                continue

            sz_a = image_sizes.get(la.get("image_id", ""), (640, 480))
            sz_b = image_sizes.get(lb.get("image_id", ""), (640, 480))

            ca = ((bbox_a[0] + bbox_a[2]) / 2 / sz_a[0],
                  (bbox_a[1] + bbox_a[3]) / 2 / sz_a[1])
            cb = ((bbox_b[0] + bbox_b[2]) / 2 / sz_b[0],
                  (bbox_b[1] + bbox_b[3]) / 2 / sz_b[1])

            dist = ((ca[0] - cb[0]) ** 2 + (ca[1] - cb[1]) ** 2) ** 0.5
            if dist < 0.20:
                shared.append(f"{la['type']}_{len(shared)}")

    unique_shared = list(set(shared))
    total = max(len(landmarks_a), len(landmarks_b), 1)
    score = min(len(unique_shared) / max(total * 0.3, 1), 1.0)
    return float(np.clip(score, 0, 1)), unique_shared


# ============================================================
# STAGE E: Spatial consistency
# ============================================================

def _spatial_consistency(
    idx_a: int, idx_b: int, total_images: int,
) -> float:
    """Score based on capture sequence adjacency.

    Adjacent images are more likely to overlap.
    Also supports loop closure (first ↔ last).
    """
    diff = abs(idx_a - idx_b)

    if diff == 1:
        return 1.0  # adjacent
    elif diff == 2:
        return 0.7  # near-adjacent
    elif diff == 3:
        return 0.4  # possible loop closure area
    elif idx_a == 0 and idx_b == total_images - 1:
        return 0.6  # loop closure candidate
    else:
        return max(0.0, 0.3 - diff * 0.05)


# ============================================================
# STAGE F: Semantic consistency
# ============================================================

def _semantic_consistency(
    landmarks_a: list[dict], landmarks_b: list[dict],
) -> float:
    """Check if the semantic content is consistent."""
    types_a = set(l.get("type", "") for l in landmarks_a)
    types_b = set(l.get("type", "") for l in landmarks_b)

    if not types_a and not types_b:
        return 0.5  # both empty = neutral
    if not types_a or not types_b:
        return 0.3

    overlap = types_a & types_b
    union = types_a | types_b
    return len(overlap) / len(union) if union else 0.0


# ============================================================
# COMBINED OVERLAP SCORE
# ============================================================

def _combine_scores(
    global_s: float, feature_s: float, geometry_s: float,
    landmark_s: float, spatial_s: float, semantic_s: float,
) -> float:
    """Weighted combination of all overlap signals."""
    weights = {
        "global": 0.10,
        "feature": 0.25,
        "geometry": 0.30,
        "landmark": 0.15,
        "spatial": 0.10,
        "semantic": 0.10,
    }
    score = (
        weights["global"] * global_s
        + weights["feature"] * feature_s
        + weights["geometry"] * geometry_s
        + weights["landmark"] * landmark_s
        + weights["spatial"] * spatial_s
        + weights["semantic"] * semantic_s
    )
    return float(np.clip(score, 0, 1))


# ============================================================
# PUBLIC API
# ============================================================

def detect_overlap(
    feat_a: ImageFeatures,
    feat_b: ImageFeatures,
    img_a: np.ndarray | None = None,
    img_b: np.ndarray | None = None,
    landmarks_a: list[dict] | None = None,
    landmarks_b: list[dict] | None = None,
    image_sizes: dict[str, tuple[int, int]] | None = None,
    idx_a: int = 0,
    idx_b: int = 1,
    total_images: int = 2,
) -> OverlapResult:
    """Full multi-stage overlap detection between two images."""
    result = OverlapResult(
        image_a=feat_a.image_id,
        image_b=feat_b.image_id,
    )

    # STAGE A: Global similarity
    if img_a is not None and img_b is not None:
        result.global_score = _global_similarity(img_a, img_b)

    # STAGE B: Feature matching
    raw, good, good_matches = _feature_matching(feat_a, feat_b)
    result.raw_matches = raw
    result.ratio_test_matches = good
    result.feature_score = _compute_feature_score(
        raw, good, feat_a.num_keypoints, feat_b.num_keypoints,
    )

    # STAGE C: Geometric verification
    inlier_ratio, inlier_count, geo_score, H = _geometric_verification(
        feat_a, feat_b, good_matches,
    )
    result.geometric_inliers = inlier_count
    result.inlier_ratio = inlier_ratio
    result.geometry_score = geo_score
    result.homography = H

    # STAGE D: Landmark matching
    if landmarks_a and landmarks_b and image_sizes:
        lm_score, shared = _landmark_matching_score(
            landmarks_a, landmarks_b, image_sizes,
        )
        result.landmark_score = lm_score
        result.shared_landmarks = shared

    # STAGE E: Spatial consistency
    result.spatial_score = _spatial_consistency(idx_a, idx_b, total_images)

    # STAGE F: Semantic consistency
    result.semantic_score = _semantic_consistency(
        landmarks_a or [], landmarks_b or [],
    )

    # COMBINED
    result.combined_score = _combine_scores(
        result.global_score,
        result.feature_score,
        result.geometry_score,
        result.landmark_score,
        result.spatial_score,
        result.semantic_score,
    )

    if result.combined_score >= CONFIRMED_THRESHOLD:
        result.status = "confirmed"
    elif result.combined_score >= POSSIBLE_THRESHOLD:
        result.status = "possible"
    else:
        result.status = "rejected"

    logger.info(
        "[OVERLAP] %s ↔ %s: combined=%.3f [%s] "
        "(global=%.2f feature=%.2f geometry=%.2f landmark=%.2f spatial=%.2f semantic=%.2f)",
        feat_a.image_id, feat_b.image_id,
        result.combined_score, result.status,
        result.global_score, result.feature_score,
        result.geometry_score, result.landmark_score,
        result.spatial_score, result.semantic_score,
    )

    return result


def detect_all_overlaps(
    features: list[ImageFeatures],
    images: list[np.ndarray] | None = None,
    all_landmarks: list[list[dict]] | None = None,
    image_sizes: dict[str, tuple[int, int]] | None = None,
) -> list[OverlapResult]:
    """Compute pairwise overlaps for all image pairs with full pipeline."""
    results: list[OverlapResult] = []
    n = len(features)

    for i in range(n):
        for j in range(i + 1, n):
            img_a = images[i] if images and i < len(images) else None
            img_b = images[j] if images and j < len(images) else None
            lm_a = all_landmarks[i] if all_landmarks and i < len(all_landmarks) else None
            lm_b = all_landmarks[j] if all_landmarks and j < len(all_landmarks) else None

            result = detect_overlap(
                features[i], features[j],
                img_a=img_a, img_b=img_b,
                landmarks_a=lm_a, landmarks_b=lm_b,
                image_sizes=image_sizes,
                idx_a=i, idx_b=j,
                total_images=n,
            )
            results.append(result)

    confirmed = sum(1 for r in results if r.status == "confirmed")
    possible = sum(1 for r in results if r.status == "possible")
    logger.info(
        "[OVERLAP] %d pairs: %d confirmed, %d possible, %d rejected",
        len(results), confirmed, possible,
        len(results) - confirmed - possible,
    )
    return results
