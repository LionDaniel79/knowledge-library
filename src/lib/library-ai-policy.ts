export interface LibraryAiPolicy {
  runtimeMode: "manual_only";
  requestsEnabled: boolean;
  developmentLimitUsd: string | null;
  runtimeMonthlyLimitUsd: string | null;
  requestLimitUsd: string | null;
  version: number;
}
export const defaultAiPolicy: LibraryAiPolicy = {
  runtimeMode: "manual_only",
  requestsEnabled: false,
  developmentLimitUsd: null,
  runtimeMonthlyLimitUsd: null,
  requestLimitUsd: null,
  version: 0,
};
