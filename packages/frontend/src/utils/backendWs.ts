function normalizeWsBase(value: string | undefined) {
  if (!value) return "";
  return value.replace(/^http:/, "ws:").replace(/^https:/, "wss:").replace(/\/$/, "");
}

type PageLocation = Pick<Location, "protocol" | "host">;

export function resolveBackendWsUrl(
  path: string,
  location: PageLocation,
  configuredWsUrl?: string,
) {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const configuredBase = normalizeWsBase(configuredWsUrl);

  if (configuredBase) {
    return `${configuredBase}${normalizedPath}`;
  }

  return `${protocol}//${location.host}${normalizedPath}`;
}

export function getBackendWsUrl(path: string) {
  return resolveBackendWsUrl(
    path,
    window.location,
    import.meta.env.VITE_WS_URL,
  );
}
