// Barrel da auth headless do CLI (lado cliente — EST-0942 / CLI-SEC-1/2).
export * from './types.js';
export * from './errors.js';
export * from './pat.js';
export * from './jwt-claims.js';
export * from './credential-store.js';
export * from './identity-client.js';
export * from './device-flow.js';
export * from './login-service.js';
// ADR-0120 / EST-1114 — OAuth 2.0 PKCE p/ login por ASSINATURA (backend local BYO).
export * from './oauth/pkce.js';
