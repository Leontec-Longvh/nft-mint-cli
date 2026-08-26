import type {
  OpenSeaDrop,
} from "../opensea/types.js";

import type {
  PhaseDetection,
  MintStage,
} from "./types.js";

export class PhaseDetector {
  detect(
    drop: OpenSeaDrop | null,
    now = new Date(),
  ): PhaseDetection {
    if (!drop) {
      return {
        type: "UNKNOWN",
        confidence: 0,
        detectedAt: Date.now(),
        currentStage: null,
        nextStage: null,
        reasons: [
          "OpenSea drop data is unavailable",
        ],
      };
    }

    const stages = this.normalizeStages(
      drop,
    );

    if (stages.length === 0) {
      return {
        type: "UNKNOWN",
        confidence: 0.2,
        detectedAt: Date.now(),
        currentStage: null,
        nextStage: null,
        reasons: [
          "No mint stages returned by OpenSea",
        ],
      };
    }

    const currentStage =
      stages.find((stage) =>
        this.isActive(stage, now),
      ) ?? null;

    const nextStage =
      stages.find(
        (stage) =>
          stage.startTime !== null &&
          stage.startTime > now,
      ) ?? null;

    if (currentStage) {
      return this.detectActiveStage(
        currentStage,
        nextStage,
      );
    }

    const firstFutureStage =
      nextStage;

    if (firstFutureStage) {
      return {
        type: "UPCOMING",
        confidence: 0.95,
        detectedAt: Date.now(),
        currentStage: null,
        nextStage: firstFutureStage,
        reasons: [
          `Next stage starts at ${firstFutureStage.startTime?.toISOString()}`,
        ],
      };
    }

    return {
      type: "ENDED",
      confidence: 0.9,
      detectedAt: Date.now(),
      currentStage: null,
      nextStage: null,
      reasons: [
        "No active or future mint stage was found",
      ],
    };
  }

  private detectActiveStage(
    stage: MintStage,
    nextStage: MintStage | null,
  ): PhaseDetection {
    const label =
      stage.label.toLowerCase();

    const reasons: string[] = [
      `Active stage: ${stage.label}`,
    ];

    /*
     * Explicit allowlist / presale.
     */
    if (
      label.includes("allowlist") ||
      label.includes("whitelist") ||
      label.includes("presale") ||
      label.includes("pre-sale")
    ) {
      reasons.push(
        "Stage label indicates restricted access",
      );

      return {
        type: "ALLOWLIST",
        confidence: 0.95,
        detectedAt: Date.now(),
        currentStage: stage,
        nextStage,
        reasons,
      };
    }

    /*
     * Explicit FCFS terminology.
     */
    if (
      label.includes("fcfs") ||
      label.includes("first come") ||
      label.includes("first-come")
    ) {
      reasons.push(
        "Stage label explicitly indicates FCFS",
      );

      return {
        type: "FCFS",
        confidence: 0.98,
        detectedAt: Date.now(),
        currentStage: stage,
        nextStage,
        reasons,
      };
    }

    /*
     * Public stage.
     *
     * We deliberately do NOT automatically call
     * every public stage FCFS.
     */
    if (
      label.includes("public") ||
      label.includes("public sale") ||
      label.includes("public mint")
    ) {
      reasons.push(
        "Stage is publicly accessible",
      );

      return {
        type: "PUBLIC",
        confidence: 0.95,
        detectedAt: Date.now(),
        currentStage: stage,
        nextStage,
        reasons,
      };
    }

    return {
      type: "UNKNOWN",
      confidence: 0.5,
      detectedAt: Date.now(),
      currentStage: stage,
      nextStage,
      reasons: [
        ...reasons,
        "Stage label is not recognized",
      ],
    };
  }

  private normalizeStages(
    drop: OpenSeaDrop,
  ): MintStage[] {
    if (!drop.stages) {
      return [];
    }

    return drop.stages
      .map((stage) => ({
        label:
          stage.label ??
          "Unknown",

        startTime:
          this.parseDate(
            stage.startTime ??
              stage.startTime,
          ),

        endTime:
          this.parseDate(
            stage.endTime ??
              stage.endTime,
          ),

        price:
          stage.price !== undefined
            ? String(stage.price)
            : null,

        maxPerWallet:
          stage.maxPerWallet ??
          stage.maxPerWallet ??
          null,
      }))
      .sort(
        (a, b) =>
          (a.startTime?.getTime() ??
            Infinity) -
          (b.startTime?.getTime() ??
            Infinity),
      );
  }

  private isActive(
    stage: MintStage,
    now: Date,
  ): boolean {
    const started =
      stage.startTime === null ||
      stage.startTime <= now;

    const notEnded =
      stage.endTime === null ||
      stage.endTime > now;

    return started && notEnded;
  }

  private parseDate(
    value: unknown,
  ): Date | null {
    if (!value) {
      return null;
    }

    const date =
      new Date(String(value));

    if (
      Number.isNaN(
        date.getTime(),
      )
    ) {
      return null;
    }

    return date;
  }
}