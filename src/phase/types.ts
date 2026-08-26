export type PhaseType =
  | "UPCOMING"
  | "ALLOWLIST"
  | "PUBLIC"
  | "FCFS"
  | "ENDED"
  | "UNKNOWN";

export interface MintStage {
  label: string;
  startTime: Date | null;
  endTime: Date | null;
  price: string | null;
  maxPerWallet: number | null;
}

export interface PhaseDetection {
  type: PhaseType;

  confidence: number;

  detectedAt: number;

  currentStage: MintStage | null;

  nextStage: MintStage | null;

  reasons: string[];
}