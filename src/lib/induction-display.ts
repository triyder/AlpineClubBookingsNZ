// Client-safe types and label maps for the induction UI. Kept free of
// server-only code and the heavy default-template data so it can be imported by
// client components. API responses serialise dates to strings, so the client
// shapes below use string dates.

export type InductionItemResultValue = "YES" | "NO" | "NOT_APPLICABLE";
export type SelfAssessmentLevel = "UNDERSTAND" | "CAN_DO" | "CAN_TEACH";
export type InductionStatus = "DRAFT" | "IN_PROGRESS" | "COMPLETED" | "VOIDED";
export type InductionKind = "NEW_MEMBER" | "YOUTH_TO_FULL" | "RE_INDUCTION";
export type InductionSignerRole = "NOMINATOR" | "HUT_LEADER" | "ADMIN";
export type InductionSectionPriority =
  | "EMERGENCY"
  | "SECURITY"
  | "STARTUP"
  | "SHUTDOWN"
  | "GENERAL";

export const INDUCTION_STATUS_LABELS: Record<InductionStatus, string> = {
  DRAFT: "Draft",
  IN_PROGRESS: "In progress",
  COMPLETED: "Completed",
  VOIDED: "Voided",
};

export const INDUCTION_KIND_LABELS: Record<InductionKind, string> = {
  NEW_MEMBER: "New member",
  YOUTH_TO_FULL: "Youth → full member",
  RE_INDUCTION: "Re-induction",
};

export const INDUCTION_SIGNER_ROLE_LABELS: Record<InductionSignerRole, string> = {
  NOMINATOR: "Nominator",
  HUT_LEADER: "Hut leader",
  ADMIN: "Administrator",
};

export const INDUCTION_RESULT_LABELS: Record<InductionItemResultValue, string> = {
  YES: "Yes",
  NO: "No",
  NOT_APPLICABLE: "N/A",
};

export const SELF_ASSESSMENT_LABELS: Record<SelfAssessmentLevel, string> = {
  UNDERSTAND: "I understand it",
  CAN_DO: "I can do it",
  CAN_TEACH: "I can teach it",
};

export interface InductionItemClient {
  id: string;
  label: string;
  competencyPrompt: string | null;
  notesPrompt: string | null;
  isMandatory: boolean;
  requiresDemonstration: boolean;
}

export interface InductionSectionClient {
  id: string;
  title: string;
  description: string | null;
  priority: InductionSectionPriority;
  items: InductionItemClient[];
}

export interface InductionItemResultClient {
  itemId: string;
  result: InductionItemResultValue;
  explanationProvided: boolean;
  demonstrationProvided: boolean;
  notes: string | null;
}

export interface InductionSignOffClient {
  id: string;
  signerName: string;
  signerRole: InductionSignerRole;
  comments: string | null;
  signedAt: string;
}

export interface AssignedSignerClient {
  memberId: string;
  firstName: string;
  lastName: string;
  emailSentAt: string | null;
}

export interface InductionDetailClient {
  id: string;
  kind: InductionKind;
  status: InductionStatus;
  requiredSignOffs: number;
  inductionDate: string | null;
  completedAt: string | null;
  finalComments: string | null;
  selfAssessedAt: string | null;
  selfAssessment: Record<string, SelfAssessmentLevel> | null;
  member: { id: string; firstName: string; lastName: string };
  template: {
    id: string;
    name: string;
    version: string;
    sections: InductionSectionClient[];
  };
  itemResults: InductionItemResultClient[];
  signOffs: InductionSignOffClient[];
  assignedSigners: AssignedSignerClient[];
}

export interface AwaitingInductionClient {
  id: string;
  kind: InductionKind;
  createdAt: string;
  requiredSignOffs: number;
  signOffCount: number;
  member: { firstName: string; lastName: string };
}

export function formatInductionDate(value: string | null): string | null {
  if (!value) return null;
  return new Date(value).toLocaleDateString("en-NZ", { dateStyle: "long" });
}
