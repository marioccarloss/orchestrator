import { z } from "zod";

export const INSUFFICIENT_EVIDENCE = "INSUFFICIENT_EVIDENCE" as const;

export const InsufficientEvidenceSchema = z.strictObject({
  status: z.literal(INSUFFICIENT_EVIDENCE),
  missing: z.array(z.string().min(1).max(300)).min(1),
  nextAction: z.string().min(1).max(300),
});

export type InsufficientEvidence = z.infer<typeof InsufficientEvidenceSchema>;

export const GROUNDING_CONTRACT = `Grounding contract (mandatory):
1. Use only facts present in the supplied ticket, typed capsules, tool results, approved specification, and inspected source/diff.
2. Never invent files, symbols, behavior, command results, requirements, or runtime outcomes. Label non-factual proposals explicitly as proposals.
3. Every factual claim must be traceable to the supplied evidence. If essential evidence is absent, stop instead of guessing.
4. Missing-evidence response (use exactly this status and the active tool's field names):
   {"status":"INSUFFICIENT_EVIDENCE","missing":["<specific missing evidence>"],"nextAction":"<smallest action that can obtain it>"}

Controlled examples:
- Evidence present → proceed with the required typed output and cite the exact source location.
- Evidence absent → return INSUFFICIENT_EVIDENCE; do not fill the gap with a plausible assumption.`;
