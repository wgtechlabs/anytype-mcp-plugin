// The gateway checks upstream authentication/readiness without exposing a token.
try {
  const response = await fetch(`http://127.0.0.1:${process.env.PORT || 31013}/healthz`, {
    signal: AbortSignal.timeout(4000), redirect: 'error',
  });
  await response.body?.cancel();
  process.exit(response.status === 200 ? 0 : 1);
} catch {
  process.exit(1);
}
