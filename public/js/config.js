/* Where the client looks for its game server.
 *
 * Leave `server` empty when the Node server also serves these files (local dev,
 * or a single-host deploy) — the client then just uses the page's own origin.
 *
 * On GitHub Pages the page is static, so point this at wherever the Node server
 * is running. It MUST be wss:// (not ws://) because Pages is served over HTTPS
 * and browsers refuse insecure WebSockets from a secure page.
 *
 *   server: 'wss://pulsar-protocol.onrender.com'
 *
 * Resolution order, highest first:
 *   1. ?server=... in the URL
 *   2. whatever was last entered in the SERVER field on the deploy screen
 *   3. this value
 *   4. the page's own origin
 */
window.PP_CONFIG = {
  server: ''
};
