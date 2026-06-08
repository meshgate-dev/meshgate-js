import { MeshgateApiClient } from './api/client.js';
import type {
  ExternalApprovalEvidence,
  ExternalApprovalEvidenceAppendInput,
  ExternalApprovalRequestInput,
  ExternalApprovalStatusResponse,
  ExternalApprovalTerminalResponse,
} from './api/types.js';
import { MeshgateWaitTimeoutError } from './errors.js';

const DEFAULT_BASE_URL = 'https://api.meshgate.dev';
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_TIMEOUT_MS = 24 * 60 * 60 * 1_000;

export interface MeshgateApprovalClientConfig {
  apiKey: string;
  baseUrl?: string;
}

export interface ExternalApprovalWaitOptions {
  pollIntervalMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export class MeshgateApprovalClient {
  private readonly api: MeshgateApiClient;

  constructor(configOrApi: MeshgateApprovalClientConfig | MeshgateApiClient) {
    this.api =
      configOrApi instanceof MeshgateApiClient
        ? configOrApi
        : new MeshgateApiClient(configOrApi.apiKey, configOrApi.baseUrl ?? DEFAULT_BASE_URL);
  }

  request(input: ExternalApprovalRequestInput): Promise<ExternalApprovalStatusResponse> {
    return this.api.createApprovalRequest(input);
  }

  get(approvalId: string): Promise<ExternalApprovalStatusResponse> {
    return this.api.getExternalApprovalRequest(approvalId);
  }

  addEvidence(
    approvalId: string,
    input: ExternalApprovalEvidenceAppendInput,
  ): Promise<ExternalApprovalEvidence> {
    return this.api.appendApprovalRequestEvidence(approvalId, input);
  }

  async waitForDecision(
    approvalId: string,
    options: ExternalApprovalWaitOptions = {},
  ): Promise<ExternalApprovalTerminalResponse> {
    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const startedAt = Date.now();

    while (true) {
      throwIfAborted(options.signal);

      const approval = await this.get(approvalId);
      if (approval.status !== 'pending') {
        return approval as ExternalApprovalTerminalResponse;
      }

      if (Date.now() - startedAt >= timeoutMs) {
        throw new MeshgateWaitTimeoutError(
          `Approval ${approvalId} did not reach a terminal decision before timeout`,
          undefined,
          approvalId,
        );
      }

      await sleepWithSignal(pollIntervalMs, options.signal);
    }
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw new MeshgateWaitTimeoutError('Approval wait was aborted');
}

function sleepWithSignal(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (!signal) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new MeshgateWaitTimeoutError('Approval wait was aborted'));
      return;
    }

    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timer);
      reject(new MeshgateWaitTimeoutError('Approval wait was aborted'));
    };

    signal.addEventListener('abort', onAbort, { once: true });
  });
}
