export interface ExpectedModel {
  vendor: string;
  id: string;
  /** Display name, used to check the model that the agent reports in the response details. */
  name?: string;
}

/** The subset of an exported chat request that identifies the model that served it. */
export interface ServedRequest {
  /** The model selected in the chat input when the request was sent, e.g. `copilot/example-model` or `agent-host-copilotcli:example-model`. */
  modelId?: string;
  /** The chat agent that handled the request. */
  agentId?: string;
  /** Text the agent shows under the response, e.g. `Example Model • 1x`. */
  details?: string;
}

const AGENT_HOST_PREFIX = 'agent-host-';
const AUTO_MODEL_ID = 'auto';

/**
 * Returns why the request wasn't served by the expected model, or `undefined` when it was.
 * VS Code doesn't report a model mismatch: the chat input can replace a model it doesn't
 * support, and an agent ignores models from another vendor and uses its own default.
 */
export function findModelMismatch(expected: ExpectedModel, served: ServedRequest): string | undefined {
  const requested = `${expected.vendor}/${expected.id}`;
  if (!served.modelId) {
    return `VS Code didn't record which model the request used, so the requested model '${requested}' can't be confirmed`;
  }
  if (!matchesModelId(served.modelId, expected)) {
    return `VS Code sent the request with model '${served.modelId}' instead of the requested model '${requested}'`;
  }
  // Agent host agents only accept models from the vendor named after them, and other agents can't use those models.
  if (served.agentId && (isAgentHost(served.agentId) || isAgentHost(expected.vendor)) && served.agentId !== expected.vendor) {
    return `Agent '${served.agentId}' handled the request but doesn't accept models from vendor '${expected.vendor}', so it used its default model`;
  }
  // `auto` resolves to a different model per request, so its name never appears in the details.
  if (expected.name && expected.id !== AUTO_MODEL_ID && served.details) {
    const reported = served.details.split('•')[0].trim();
    if (reported !== expected.name) {
      return `The response reports model '${reported}' instead of the requested model '${expected.name}' (details: '${served.details}')`;
    }
  }
  return undefined;
}

function matchesModelId(modelId: string, expected: ExpectedModel): boolean {
  return modelId === `${expected.vendor}/${expected.id}` || modelId === `${expected.vendor}:${expected.id}`;
}

export const LOCAL_HARNESS = 'local';

/**
 * Returns why the request didn't run in the requested harness (chat session type), or `undefined`
 * when it did. VS Code locks a chat of any non-local session type to the agent with that session
 * type's ID, while local chats use the default agent. Policy can silently replace a requested
 * `local` chat with another session type, so this can't be checked before the request runs.
 *
 * @param sessionTypes Known non-local session types, used to recognize their agents.
 */
export function findHarnessMismatch(harness: string, agentId: string | undefined, sessionTypes: readonly string[]): string | undefined {
  if (!agentId) {
    return `VS Code didn't record which agent handled the request, so the requested harness '${harness}' can't be confirmed`;
  }
  if (harness === LOCAL_HARNESS) {
    const isSessionTypeAgent = isAgentHost(agentId) || sessionTypes.some((type) => type !== LOCAL_HARNESS && type === agentId);
    return isSessionTypeAgent
      ? `The request ran in harness '${agentId}' instead of the requested harness '${harness}'. Policy, such as Copilot managed settings, can require a harness.`
      : undefined;
  }
  return agentId === harness
    ? undefined
    : `The request was handled by agent '${agentId}' instead of the requested harness '${harness}'`;
}

function isAgentHost(value: string): boolean {
  return value.startsWith(AGENT_HOST_PREFIX);
}
