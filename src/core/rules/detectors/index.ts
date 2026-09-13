import { detectBackend } from "./backend.js";
import { detectBoundaries } from "./boundaries.js";
import { detectGit } from "./git.js";
import { detectModules } from "./modules.js";
import { detectNaming } from "./naming.js";
import { detectQuality } from "./quality.js";
import { detectStateData } from "./state-data.js";
import { detectStyles } from "./styles.js";
import { detectTesting } from "./testing.js";
import type { RepositoryDetector } from "./types.js";

export const REPOSITORY_DETECTORS: readonly RepositoryDetector[] = [
  detectNaming,
  detectModules,
  detectStyles,
  detectStateData,
  detectBackend,
  detectTesting,
  detectQuality,
  detectGit,
  detectBoundaries,
];

export type { DetectorResult, RepositoryDetector, RepositoryDetectorContext } from "./types.js";
