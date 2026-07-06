// @jawere/ai — Model registry with auto-discovery

import type {
  Model,
  Provider,
  ProviderId,
  Api,
  Models,
} from "./types.ts";

export class ModelRegistry implements Models {
  private providers: Map<ProviderId, Provider> = new Map();
  private modelIndex: Map<string, Model> = new Map();
  private modelToProvider: Map<string, ProviderId> = new Map();

  /** Register a provider and its models */
  register(provider: Provider): void {
    if (this.providers.has(provider.id)) {
      console.warn(`[ModelRegistry] Provider "${provider.id}" already registered — overwriting.`);
    }
    this.providers.set(provider.id, provider);

    // Index models
    for (const model of provider.getModels()) {
      this.modelIndex.set(model.id, model);
      this.modelToProvider.set(model.id, provider.id);
    }
  }

  /** Unregister a provider by ID */
  unregister(id: ProviderId): boolean {
    const provider = this.providers.get(id);
    if (!provider) return false;

    // Remove model index entries
    for (const model of provider.getModels()) {
      if (this.modelToProvider.get(model.id) === id) {
        this.modelIndex.delete(model.id);
        this.modelToProvider.delete(model.id);
      }
    }

    return this.providers.delete(id);
  }

  // ── Models interface ────────────────────────────────────────────

  getProviders(): readonly Provider[] {
    return [...this.providers.values()];
  }

  getProvider(id: ProviderId): Provider | undefined {
    return this.providers.get(id);
  }

  getModel(id: string): Model | undefined {
    return this.modelIndex.get(id);
  }

  listModels(): Model[] {
    return [...this.modelIndex.values()];
  }

  async refreshAll(): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const provider of this.providers.values()) {
      if (provider.refreshModels) {
        promises.push(
          provider.refreshModels().catch((err) => {
            console.warn(`[ModelRegistry] Failed to refresh models for "${provider.id}":`, err);
          }),
        );
      }
    }
    await Promise.all(promises);

    // Rebuild index after refresh
    this.modelIndex.clear();
    this.modelToProvider.clear();
    for (const provider of this.providers.values()) {
      for (const model of provider.getModels()) {
        this.modelIndex.set(model.id, model);
        this.modelToProvider.set(model.id, provider.id);
      }
    }
  }

  // ── Convenience ─────────────────────────────────────────────────

  /** Find models by provider */
  getModelsByProvider(providerId: ProviderId): Model[] {
    return [...this.modelIndex.values()].filter(
      (m) => m.provider === providerId,
    );
  }

  /** Find models by API type */
  getModelsByApi(api: Api): Model[] {
    return [...this.modelIndex.values()].filter((m) => m.api === api);
  }

  /** Find models that support images */
  getImageModels(): Model[] {
    return [...this.modelIndex.values()].filter(
      (m) => m.supportsImages || m.input.includes("image"),
    );
  }

  /** Find models that support reasoning */
  getReasoningModels(): Model[] {
    return [...this.modelIndex.values()].filter((m) => m.reasoning);
  }

  /** Find provider for a model */
  getProviderForModel(modelId: string): Provider | undefined {
    const providerId = this.modelToProvider.get(modelId);
    if (!providerId) return undefined;
    return this.providers.get(providerId);
  }

  /** Get the stream function for a model */
  getStreamFn(modelId: string) {
    const model = this.modelIndex.get(modelId);
    if (!model) return undefined;

    const provider = this.providers.get(model.provider as ProviderId);
    if (!provider) return undefined;

    return (ctx: any, opts?: any) => provider.stream(model, ctx, opts);
  }
}

/** Global singleton */
let globalRegistry: ModelRegistry | null = null;

export function getModelRegistry(): ModelRegistry {
  if (!globalRegistry) {
    globalRegistry = new ModelRegistry();
  }
  return globalRegistry;
}

export function setModelRegistry(registry: ModelRegistry): void {
  globalRegistry = registry;
}
