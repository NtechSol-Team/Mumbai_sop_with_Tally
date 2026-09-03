/**
 * Where the browser should reach the API and the realtime socket.
 *
 * `NEXT_PUBLIC_API_URL` is inlined at build/dev-start time, so on a LAN dev box
 * it freezes whatever IP the machine had at that moment. The moment DHCP hands
 * out a new lease, every tablet and PC on the network keeps calling the old
 * address and gets ERR_CONNECTION_REFUSED / a dead WebSocket — with nothing in
 * the app to hint why. This has already happened twice on this machine.
 *
 * So for **private/LAN targets only**, the host is re-derived at runtime from
 * whatever address the browser actually used to load the page: open the app on
 * http://192.168.2.104:3000 and the API is http://192.168.2.104:4000, open it on
 * localhost and it stays localhost. The port and protocol from the configured
 * URL are kept as-is.
 *
 * Production is deliberately left alone: there the web origin (e.g.
 * erp.example.com) and the API origin (e.g. api.erp.example.com) are genuinely
 * different hosts, so deriving one from the other would point every call at the
 * wrong server.
 */

/** localhost, or any RFC1918 range — i.e. a dev machine, not a deployed host. */
function isPrivateHost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '::1' ||
    /^127\./.test(hostname) ||
    /^10\./.test(hostname) ||
    /^192\.168\./.test(hostname) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
  );
}

function resolve(configured: string): string {
  // Server-side render: no window, and the build-time value is all there is.
  if (typeof window === 'undefined') return configured;
  try {
    const url = new URL(configured);
    if (!isPrivateHost(url.hostname)) return configured;      // deployed — trust the env
    if (url.hostname === window.location.hostname) return configured;
    url.hostname = window.location.hostname;
    return url.origin;
  } catch {
    return configured; // malformed env value — better to fail loudly at the call site
  }
}

const CONFIGURED_API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
const CONFIGURED_SOCKET = process.env.NEXT_PUBLIC_SOCKET_URL ?? CONFIGURED_API;

export const apiOrigin = (): string => resolve(CONFIGURED_API);
export const socketOrigin = (): string => resolve(CONFIGURED_SOCKET);
