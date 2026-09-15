import {
  ErrorCodes,
  FAMILY_SYNC_DEFAULT_LIMIT,
  errorShape,
  validateFamilyBootstrapParams,
  validateFamilyListParams,
  validateFamilyMutateParams,
  validateFamilySyncParams,
  type FamilyRecordKind,
} from "../../../packages/gateway-protocol/src/index.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  FamilyDomainConflictError,
  FamilyDomainInvalidError,
  listFamilyRecords,
  mutateFamilyRecord,
} from "../../state/family-domain.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";
import { resolveAuthenticatedProfileId } from "./users-profile-access.js";
import { assertValidParams } from "./validation.js";

const LIST_METHOD_KINDS = {
  "family.feed.list": "feed_item",
  "family.ideas.list": "idea",
  "family.goals.list": "goal",
  "family.library.list": "library_item",
  "family.actions.list": "action_request",
} as const satisfies Record<string, FamilyRecordKind>;

const MUTATE_METHOD_KINDS = {
  "family.feed.mutate": "feed_item",
  "family.ideas.mutate": "idea",
  "family.goals.mutate": "goal",
  "family.library.mutate": "library_item",
  "family.actions.mutate": "action_request",
} as const satisfies Record<string, FamilyRecordKind>;

function requireFamilyScope(options: GatewayRequestHandlerOptions) {
  const profileId = resolveAuthenticatedProfileId(options.client);
  const agentId = options.client?.internal?.assignedAgentId;
  if (!profileId || !agentId) {
    options.respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.FORBIDDEN,
        "Family methods require an authenticated profile assigned to exactly one agent",
      ),
    );
    return undefined;
  }
  return { profileId, agentId };
}

function respondError(options: GatewayRequestHandlerOptions, error: unknown): void {
  const code =
    error instanceof FamilyDomainConflictError || error instanceof FamilyDomainInvalidError
      ? ErrorCodes.INVALID_REQUEST
      : ErrorCodes.UNAVAILABLE;
  options.respond(false, undefined, errorShape(code, formatErrorMessage(error)));
}

function list(options: GatewayRequestHandlerOptions, kind?: FamilyRecordKind): void {
  if (
    !assertValidParams(
      options.params,
      validateFamilyListParams,
      options.req.method,
      options.respond,
    )
  ) {
    return;
  }
  const scope = requireFamilyScope(options);
  if (!scope) {
    return;
  }
  try {
    options.respond(
      true,
      listFamilyRecords({
        ...scope,
        ...(kind ? { kind } : {}),
        ...(options.params.cursor ? { cursor: options.params.cursor } : {}),
        limit: options.params.limit ?? FAMILY_SYNC_DEFAULT_LIMIT,
      }),
      undefined,
    );
  } catch (error) {
    respondError(options, error);
  }
}

function mutate(options: GatewayRequestHandlerOptions, kind: FamilyRecordKind): void {
  if (
    !assertValidParams(
      options.params,
      validateFamilyMutateParams,
      options.req.method,
      options.respond,
    )
  ) {
    return;
  }
  const scope = requireFamilyScope(options);
  if (!scope) {
    return;
  }
  try {
    options.respond(true, mutateFamilyRecord({ ...scope, kind }, options.params), undefined);
  } catch (error) {
    respondError(options, error);
  }
}

const listHandlers = Object.fromEntries(
  Object.entries(LIST_METHOD_KINDS).map(([method, kind]) => [
    method,
    (options: GatewayRequestHandlerOptions) => list(options, kind),
  ]),
) as GatewayRequestHandlers;

const mutateHandlers = Object.fromEntries(
  Object.entries(MUTATE_METHOD_KINDS).map(([method, kind]) => [
    method,
    (options: GatewayRequestHandlerOptions) => mutate(options, kind),
  ]),
) as GatewayRequestHandlers;

export const familyDomainHandlers: GatewayRequestHandlers = {
  "family.bootstrap": (options) => {
    if (
      !assertValidParams(
        options.params,
        validateFamilyBootstrapParams,
        "family.bootstrap",
        options.respond,
      )
    ) {
      return;
    }
    const scope = requireFamilyScope(options);
    if (!scope) {
      return;
    }
    try {
      const page = listFamilyRecords({ ...scope, limit: FAMILY_SYNC_DEFAULT_LIMIT });
      options.respond(
        true,
        {
          ...page,
          // These are the caller's live granted scopes, not configured expectations.
          capabilities: [...(options.client?.connect.scopes ?? [])].toSorted(),
        },
        undefined,
      );
    } catch (error) {
      respondError(options, error);
    }
  },
  "family.sync": (options) => {
    if (
      !assertValidParams(options.params, validateFamilySyncParams, "family.sync", options.respond)
    ) {
      return;
    }
    list(options);
  },
  ...listHandlers,
  ...mutateHandlers,
};
