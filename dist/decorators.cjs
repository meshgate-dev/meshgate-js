'use strict';

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

exports.guardrail = guardrail;
//# sourceMappingURL=decorators.cjs.map
//# sourceMappingURL=decorators.cjs.map