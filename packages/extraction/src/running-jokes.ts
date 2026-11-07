import type { MergedCandidate } from "./merge";

/**
 * Cross-session pass for the "Running joke" category. NOT IMPLEMENTED.
 *
 * Pass 1 never emits this category (it is rejected there), because a running joke only exists
 * across many sessions: the same bit coming back over weeks. When this is built it should:
 *
 * 1. Take the run's merged events plus a keyword or embedding pass over messages to find phrases
 *    that recur across sessions far apart in time.
 * 2. Ask the model about each cluster of refs, with the same hard validators (refs exist, dates
 *    inside the evidence range) and `evidence` spanning the recurrences.
 * 3. Return Running joke candidates for the same run, so they are reviewed with everything else.
 *
 * It runs after pass 2 and before the review export, inside the same extraction run.
 */
export type RunningJokePass = (events: readonly MergedCandidate[]) => Promise<MergedCandidate[]>;

export const runningJokePass: RunningJokePass = async () => {
  throw new Error("running joke pass is not implemented yet");
};
