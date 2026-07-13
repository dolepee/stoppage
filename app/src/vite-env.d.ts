/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_RUNTIME_MODE?: "api" | "local";
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
