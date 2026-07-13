export type RuntimeMode = "api" | "local";

export function resolveRuntimeMode(value: unknown): RuntimeMode {
  if (value === undefined || value === "" || value === "api") return "api";
  if (value === "local") return "local";
  throw new Error(`Unsupported VITE_RUNTIME_MODE: ${String(value)}`);
}
