// Resolves a ModelRef to a fake or real language model.
import type { LanguageModelV4 } from "@ai-sdk/provider";
import type { ResolveModel } from "./adapter.ts";
import { createRealLanguageModel, NO_SECRETS, type RealProviderOptions } from "./providers.ts";

export interface ResolverOptions {
  fakes?: Record<string, LanguageModelV4>;

  real?: RealProviderOptions;
}

export function createModelResolver(opts: ResolverOptions): ResolveModel {
  const real: RealProviderOptions = opts.real ?? { enabled: false, secrets: NO_SECRETS };
  return async (ref) => {
    if (ref.provider === "fake") {
      const m = opts.fakes?.[ref.model];
      return m ? { ok: true, model: m } : { ok: false, code: "fake_model_missing" };
    }
    return createRealLanguageModel(ref.provider, ref.model, real);
  };
}
