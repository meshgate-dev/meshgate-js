import { M as MeshgateClient, G as GuardOptions } from './client-Dr9Hovo6.cjs';

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

/**
 * Method decorator that wraps the decorated async method with `client.guard()`.
 *
 * @param client - The `MeshgateClient` instance to register this guard on.
 * @param options - Guard options (intent name, getIntentArgs, etc.).
 *
 * @throws {MeshgateConfigError} at class-definition time if `options.intent`
 *   is already registered on `client`.
 */
declare function guardrail<TArgs extends unknown[], TReturn>(client: MeshgateClient, options: GuardOptions<TArgs>): (originalMethod: (...args: TArgs) => Promise<TReturn>, _ctx: ClassMethodDecoratorContext) => (...args: TArgs) => Promise<TReturn>;

export { guardrail };
