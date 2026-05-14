/**
 * @meshgate/sdk/decorators — opt-in TypeScript 5.x standard decorator API.
 *
 * Import path: `@meshgate/sdk/decorators` — NOT re-exported from the main barrel.
 *
 * Requires TypeScript ≥ 5.0 with standard decorators (NOT `experimentalDecorators`).
 * Your tsconfig.json must NOT have `"experimentalDecorators": true`.
 *
 * @example
 * ```typescript
 * import { guardrail } from '@meshgate/sdk/decorators';
 *
 * class PaymentService {
 *   @guardrail(client, {
 *     intent: 'process_refund',
 *     getIntentArgs: (_cid: string, amount: number) => ({ amount }),
 *   })
 *   async processRefund(customerId: string, amount: number): Promise<Refund> {
 *     return await stripe.refunds.create({ charge: customerId, amount });
 *   }
 * }
 * ```
 *
 * The decorator is equivalent to:
 * ```typescript
 * processRefund = client.guard(processRefund, options);
 * ```
 *
 * **`this` binding note:** `guardrail` registers the guard once at class-definition
 * time. The binding trick used here is safe for single-instance classes and for
 * methods that do not use `this`. For multi-instance concurrent usage where the
 * method reads `this` instance state, use `client.guard()` directly to guarantee
 * correct per-call `this` binding.
 */

import type { MeshgateClient } from './client.js';
import type { GuardOptions } from './types.js';

/**
 * Method decorator that wraps the decorated async method with `client.guard()`.
 *
 * @param client - The `MeshgateClient` instance to register this guard on.
 * @param options - Guard options (intent name, getIntentArgs, etc.).
 *
 * @throws {MeshgateConfigError} at class-definition time if `options.intent`
 *   is already registered on `client`.
 */
export function guardrail<TArgs extends unknown[], TReturn>(
  client: MeshgateClient,
  options: GuardOptions<TArgs>,
) {
  return function (
    originalMethod: (...args: TArgs) => Promise<TReturn>,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _ctx: ClassMethodDecoratorContext,
  ): (...args: TArgs) => Promise<TReturn> {
    // Capture `this` per-call via a shared binding reference.
    // Because JavaScript is single-threaded, the assignment and the synchronous
    // start of `guarded()` are atomic — no interleaving can occur before the
    // first await inside guard(). This is safe for the common single-instance
    // and non-`this`-dependent cases. See module JSDoc for multi-instance caveats.
    const binding: { self: unknown } = { self: undefined };

    const guarded = client.guard(
      (...args: TArgs): Promise<TReturn> => originalMethod.call(binding.self, ...args),
      options,
    );

    return function (this: unknown, ...args: TArgs): Promise<TReturn> {
      binding.self = this;
      return guarded(...args);
    };
  };
}
