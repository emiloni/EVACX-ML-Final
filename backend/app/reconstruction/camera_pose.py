"""Camera pose estimation from overlapping photographs.

Estimates relative camera positions using:
- Essential matrix estimation
- RecoverPose
- RANSAC for robustness

Produces a spatial trajectory of camera positions.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field

import cv2
import numpy as np

from app.reconstruction.image_features import ImageFeatures
from app.reconstruction.overlap_detector import OverlapResult

logger = logging.getLogger(__name__)


@dataclass
class CameraPose:
    """Relative camera pose."""
    image_id: str
    index: int
    position: np.ndarray = field(
        default_factory=lambda: np.zeros(3)
    )
    rotation: np.ndarray = field(
        default_factory=lambda: np.eye(3)
    )
    estimated: bool = False


@dataclass
class PoseGraph:
    """Complete pose graph for all photos."""
    poses: dict[str, CameraPose] = field(default_factory=dict)
    relative_transforms: dict[tuple[str, str], np.ndarray] = field(
        default_factory=dict
    )

    @property
    def estimated_count(self) -> int:
        return sum(1 for p in self.poses.values() if p.estimated)


def estimate_relative_pose(
    feat_a: ImageFeatures,
    feat_b: ImageFeatures,
    overlap: OverlapResult,
    focal_length: float | None = None,
) -> np.ndarray | None:
    """Estimate relative pose between two overlapping images.

    Uses essential matrix + RecoverPose.

    Returns 4x4 transformation matrix or None.
    """
    status = getattr(overlap, 'status', 'rejected')
    if status not in ('confirmed', 'possible') or overlap.homography is None:
        return None

    if feat_a.descriptors is None or feat_b.descriptors is None:
        return None

    # Re-match descriptors for essential matrix
    bf = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=False)
    try:
        raw = bf.knnMatch(feat_a.descriptors, feat_b.descriptors, k=2)
    except cv2.error:
        return None

    good = []
    for m_list in raw:
        if len(m_list) == 2:
            m, n = m_list
            if m.distance < 0.75 * n.distance:
                good.append(m)

    if len(good) < 8:
        return None

    pts_a = np.float32([
        feat_a.keypoints[m.queryIdx].pt for m in good
    ]).reshape(-1, 1, 2)
    pts_b = np.float32([
        feat_b.keypoints[m.trainIdx].pt for m in good
    ]).reshape(-1, 1, 2)

    # Camera intrinsics (approximate if not known)
    w, h = feat_a.width, feat_a.height
    if focal_length is None:
        focal_length = max(w, h) * 1.2

    K = np.array([
        [focal_length, 0, w / 2],
        [0, focal_length, h / 2],
        [0, 0, 1],
    ], dtype=np.float64)

    # Essential matrix
    E, mask = cv2.findEssentialMat(
        pts_a, pts_b, K, method=cv2.RANSAC,
        prob=0.999, threshold=1.0,
    )

    if E is None or mask is None:
        return None

    inliers = int(mask.sum())
    if inliers < 8:
        return None

    # Recover relative pose
    _, R, t, _ = cv2.recoverPose(E, pts_a, pts_b, K, mask=mask)

    # Build 4x4 transformation matrix
    T = np.eye(4)
    T[:3, :3] = R
    T[:3, 3] = t.flatten()

    return T


def build_pose_graph(
    features: list[ImageFeatures],
    overlaps: list[OverlapResult],
) -> PoseGraph:
    """Build camera pose graph from features and overlaps.

    Estimates relative poses for each confirmed overlap pair
    and chains them to build a global trajectory.
    """
    pose_graph = PoseGraph()

    # Initialize poses
    for i, feat in enumerate(features):
        pose_graph.poses[feat.image_id] = CameraPose(
            image_id=feat.image_id,
            index=i,
        )

    # Set first camera as origin
    if features:
        first_id = features[0].image_id
        pose_graph.poses[first_id].estimated = True
        pose_graph.poses[first_id].position = np.zeros(3)
        pose_graph.poses[first_id].rotation = np.eye(3)

    # Estimate relative poses for confirmed overlaps
    feat_map = {f.image_id: f for f in features}

    for overlap in overlaps:
        status = getattr(overlap, 'status', 'rejected')
        if status not in ('confirmed', 'possible'):
            continue

        feat_a = feat_map.get(overlap.image_a)
        feat_b = feat_map.get(overlap.image_b)
        if feat_a is None or feat_b is None:
            continue

        T = estimate_relative_pose(feat_a, feat_b, overlap)
        if T is not None:
            key = (overlap.image_a, overlap.image_b)
            pose_graph.relative_transforms[key] = T

    # Propagate poses along the graph (BFS from first camera)
    if features:
        _propagate_poses(pose_graph, features[0].image_id)

    logger.info(
        "[POSE] %d/%d camera poses estimated",
        pose_graph.estimated_count, len(features),
    )

    return pose_graph


def _propagate_poses(pose_graph: PoseGraph, start_id: str) -> None:
    """Propagate camera poses from start using BFS."""
    from collections import deque

    visited: set[str] = {start_id}
    queue = deque([start_id])

    while queue:
        current = queue.popleft()
        current_pose = pose_graph.poses[current]

        for (a, b), T in pose_graph.relative_transforms.items():
            neighbor = None
            T_use = None

            if a == current and b not in visited:
                neighbor = b
                T_use = T
            elif b == current and a not in visited:
                neighbor = a
                T_use = np.linalg.inv(T)

            if neighbor is not None and T_use is not None:
                pose_graph.poses[neighbor].position = (
                    current_pose.rotation @ T_use[:3, 3]
                    + current_pose.position
                )
                pose_graph.poses[neighbor].rotation = (
                    current_pose.rotation @ T_use[:3, :3]
                )
                pose_graph.poses[neighbor].estimated = True
                visited.add(neighbor)
                queue.append(neighbor)
