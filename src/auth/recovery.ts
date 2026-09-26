const SESSION_ID_PATTERN = /session_[0-9a-f]{64,256}/;

// The session id goes in the fragment (#), which browsers never send to servers: it stays out of
// access logs and Referer headers. The link is not a credential on its own: signing in with it
// still takes a Session Proof from the same World ID, on its owner's phone.
export const recoveryUrl = (publicUrl: string, sessionId: string) =>
  `${new URL("/login/recover", publicUrl).href}#${sessionId}`;

// Accepts the full link or the bare id; null if nothing matches.
export const parseRecoveryInput = (input: string) => input.trim().match(SESSION_ID_PATTERN)?.[0] ?? null;
