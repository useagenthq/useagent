export function openCodeModelBody(model: string): { providerID: string; modelID: string } {
  if (model.startsWith("openai/")) {
    return { providerID: "openai", modelID: model.slice("openai/".length) };
  }
  if (model.startsWith("cerebras/")) {
    return { providerID: "cerebras", modelID: model.slice("cerebras/".length) };
  }
  return model.includes("/")
    ? { providerID: "openrouter", modelID: model }
    : { providerID: "anthropic", modelID: model };
}
