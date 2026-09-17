import { z } from "zod";
import { compactJson } from "./files.js";

export const InternalReceiptRoleSchema = z.enum(["mr-general", "mr-sdd-apply", "mr-fix"]);

export const InternalVerificationResultSchema = z.strictObject({
  command: z.string().min(1).max(200),
  exitCode: z.number().int(),
});

export const InternalExecutionReceiptSchema = z.strictObject({
  schemaVersion: z.literal(1),
  language: z.literal("en"),
  role: InternalReceiptRoleSchema,
  status: z.enum(["COMPLETED", "BLOCKED"]),
  summary: z.string().min(1).max(160),
  changedFiles: z.array(z.string().min(1)).max(50).default([]),
  verification: z.array(InternalVerificationResultSchema).max(20).default([]),
  blocker: z.string().min(1).max(240).optional(),
}).superRefine((receipt, context) => {
  if (receipt.status === "COMPLETED" && receipt.blocker !== undefined) {
    context.addIssue({ code: "custom", path: ["blocker"], message: "A completed receipt cannot include a blocker" });
  }
  if (receipt.status === "BLOCKED" && receipt.blocker === undefined) {
    context.addIssue({ code: "custom", path: ["blocker"], message: "A blocked receipt requires a blocker" });
  }
});

export type InternalExecutionReceipt = z.infer<typeof InternalExecutionReceiptSchema>;

export function serializeInternalExecutionReceipt(receipt: InternalExecutionReceipt): string {
  return compactJson(InternalExecutionReceiptSchema.parse(receipt));
}
