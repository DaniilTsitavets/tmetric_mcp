/**
 * Resolution and caching of the workspace and user a tool call applies to.
 *
 * Nearly every TMetric endpoint needs an `accountId`, and most need a `userId`.
 * Forcing the agent to pass both on every call wastes turns, so they are resolved
 * once from the authenticated profile (or from environment overrides) and reused.
 */

import { ENV } from "../constants.js";
import type { TMetricUser, TMetricUserAccount } from "../types.js";
import { TMetricApiError, type TMetricClient } from "./client.js";

/** Parses an environment override, ignoring blank or non-numeric values. */
function numericEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw || !raw.trim()) return undefined;
  const parsed = Number(raw.trim());
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export class TMetricContext {
  private profile: TMetricUser | undefined;

  constructor(private readonly client: TMetricClient) {}

  /** Fetches the authenticated user's profile once and caches it for the process. */
  async getProfile(forceRefresh = false): Promise<TMetricUser> {
    if (!this.profile || forceRefresh) {
      this.profile = await this.client.request<TMetricUser>("/user");
    }
    return this.profile;
  }

  /**
   * Resolves the workspace id for a call.
   *
   * Precedence: explicit argument, then {@link ENV.ACCOUNT_ID}, then the active
   * workspace on the profile, then the only workspace the user belongs to.
   */
  async resolveAccountId(explicit?: number): Promise<number> {
    if (explicit !== undefined) return explicit;

    const override = numericEnv(ENV.ACCOUNT_ID);
    if (override !== undefined) return override;

    const profile = await this.getProfile();
    if (profile.activeAccountId) return profile.activeAccountId;

    const accounts = profile.accounts ?? [];
    if (accounts.length === 1 && accounts[0]) return accounts[0].id;

    const available = accounts.map((a) => `${a.name ?? "unnamed"} (id ${a.id})`).join(", ");
    throw new TMetricApiError(
      `Could not determine which TMetric workspace to use. Pass account_id explicitly or set ${ENV.ACCOUNT_ID}. Available workspaces: ${available || "none"}.`,
      undefined,
      "/user",
    );
  }

  /**
   * Resolves the user id for a call.
   *
   * Precedence: explicit argument, then {@link ENV.USER_ID}, then the authenticated
   * user themselves.
   */
  async resolveUserId(explicit?: number): Promise<number> {
    if (explicit !== undefined) return explicit;

    const override = numericEnv(ENV.USER_ID);
    if (override !== undefined) return override;

    return (await this.getProfile()).id;
  }

  /** Both identifiers at once, for the common case where a tool needs each. */
  async resolve(accountId?: number, userId?: number): Promise<{ accountId: number; userId: number }> {
    return {
      accountId: await this.resolveAccountId(accountId),
      userId: await this.resolveUserId(userId),
    };
  }

  /** Time-tracking rules of a workspace, used to explain rejected writes. */
  async getWorkspaceRules(accountId: number): Promise<TMetricUserAccount | undefined> {
    const profile = await this.getProfile();
    return profile.accounts?.find((account) => account.id === accountId);
  }
}
