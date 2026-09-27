/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

/** Project-specific environment variables (merged into Vite's own interface). */
interface ImportMetaEnv {
  readonly VITE_API_BASE?: string;
}
