const LOCAL_HOSTS = new Set(["0.0.0.0", "127.0.0.1", "localhost", "::1"]);

function normalizeWsBase(value: string | undefined) {
  if (!value) return "";
  return value.replace(/^http:/, "ws:").replace(/^https:/, "wss:").replace(/\/$/, "");
}

export function getBackendWsUrl(path: string) {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const configuredBase = normalizeWsBase(import.meta.env.VITE_WS_URL || import.meta.env.VITE_API_URL);

  if (configuredBase) {
    return `${configuredBase}${normalizedPath}`;
  }

  const { hostname, host, port } = window.location;

  if (!port || port === "8000") {
    return `${protocol}//${host}${normalizedPath}`;
  }

  const backendHostname = LOCAL_HOSTS.has(hostname) ? "127.0.0.1" : hostname;
  return `${protocol}//${backendHostname}:8000${normalizedPath}`;
}
