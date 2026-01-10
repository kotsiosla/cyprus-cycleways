export type RuntimeConfig = {
  /**
   * Public webhook/form endpoint (e.g. Formspree/Getform/Pipedream) used to notify admin.
   * NOTE: This is not secret once shipped to the browser.
   */
  adminNotifyEndpoint?: string;

  /**
   * SHA-256 hex digest of the admin unlock code.
   * Admin enters the code locally; we hash and compare client-side.
   */
  adminUnlockHash?: string;
};

export function getRuntimeConfig(): RuntimeConfig {
  try {
    return (globalThis as typeof globalThis & { __APP_CONFIG__?: RuntimeConfig }).__APP_CONFIG__ ?? {};
  } catch {
    return {};
  }
}

