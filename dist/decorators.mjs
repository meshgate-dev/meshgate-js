// src/decorators.ts
function guardrail(client, options) {
  return function(originalMethod, _ctx) {
    const binding = { self: void 0 };
    const guarded = client.guard(
      (...args) => originalMethod.call(binding.self, ...args),
      options
    );
    return function(...args) {
      binding.self = this;
      return guarded(...args);
    };
  };
}

export { guardrail };
//# sourceMappingURL=decorators.mjs.map
//# sourceMappingURL=decorators.mjs.map