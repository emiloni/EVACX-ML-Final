"""Feature extraction from building photographs.

Extracts ORB keypoints and descriptors for overlap detection
and multi-view reconstruction.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field

import cv2
import numpy as np

logger = logging.getLogger(__name__)

# ORB parameters
ORB_FEATURES = 3000
ORB_SCALE = 1.2
ORB_LEVELS = 8


@dataclass
class ImageFeatures:
    """Store extracted features for one image."""
    image_id: str
    width: int
    height: int
    keypoints: list = field(default_factory=list)
    descriptors: np.ndarray | None = None
    gray: np.ndarray | None = None

    @property
    def num_keypoints(self) -> int:
        return len(self.keypoints)


def extract_features(
    image_rgb: np.ndarray,
    image_id: str,
) -> ImageFeatures:
    """Extract ORB features from an RGB image.

    Parameters
    ----------
    image_rgb : RGB numpy array.
    image_id : identifier for this image.

    Returns
    -------
    ImageFeatures with keypoints and descriptors.
    """
    h, w = image_rgb.shape[:2]

    # Convert to grayscale
    gray = cv2.cvtColor(image_rgb, cv2.COLOR_RGB2GRAY)

    # CLAHE for better feature detection in varying lighting
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    gray = clahe.apply(gray)

    # Create ORB detector
    orb = cv2.ORB_create(
        nfeatures=ORB_FEATURES,
        scaleFactor=ORB_SCALE,
        nlevels=ORB_LEVELS,
    )

    keypoints, descriptors = orb.detectAndCompute(gray, None)

    if descriptors is None:
        descriptors = np.array([], dtype=np.uint8)
        keypoints = []

    features = ImageFeatures(
        image_id=image_id,
        width=w,
        height=h,
        keypoints=list(keypoints) if keypoints else [],
        descriptors=descriptors,
        gray=gray,
    )

    logger.info(
        "[FEATURES] %s: %d features extracted (%dx%d)",
        image_id, features.num_keypoints, w, h,
    )
    return features


def extract_features_batch(
    images: list[np.ndarray],
    image_ids: list[str],
) -> list[ImageFeatures]:
    """Extract features from a batch of images."""
    results: list[ImageFeatures] = []
    for img, img_id in zip(images, image_ids):
        try:
            feats = extract_features(img, img_id)
            results.append(feats)
        except Exception as exc:
            logger.warning("[FEATURES] Failed for %s: %s", img_id, exc)
    logger.info(
        "[FEATURES] Extracted features from %d/%d images",
        len(results), len(images),
    )
    return results
