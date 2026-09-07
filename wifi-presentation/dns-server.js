// ============================================================
// dns-server.js
// ============================================================
// A tiny local DNS server used to trigger each phone OS's
// built-in "Sign in to network" captive-portal prompt.
//
// HOW THIS FITS INTO THE PROJECT:
// Phones periodically ask DNS to resolve a specific "probe"
// domain (different per OS) and check whether the HTTP response
// looks like normal internet. If DNS resolves that probe domain
// to something OTHER than the real internet -- e.g. THIS laptop --
// the OS assumes the network requires sign-in and shows a
// notification. Tapping it opens a mini in-app browser to that
// same probe URL, which our Express server (see server.js) will
// answer with the real presentation landing page.
//
// This file ONLY handles step 1: making sure the probe domains
// (and, optionally, all other domains) resolve to this machine's
// LAN IP instead of the internet's real DNS. It does not know or
// care about slides, Socket.IO, or anything else -- server.js
// requires and starts it, that's the entire integration point.
//
// WHY EVERYTHING RESOLVES LOCALLY, NOT JUST THE PROBE DOMAINS:
// The project's whole point is "must work with zero internet."
// If we only intercepted the 3 known probe domains and forwarded
// everything else to the real internet, this DNS server would
// need actual internet access to be useful as a real DNS
// resolver -- which we don't have and don't want. Instead, ANY
// domain a connected phone asks about gets pointed back at this
// laptop. Most of those requests will just 404 on the Express
// server (which is fine and expected) except for the handful of
// captive-portal probe paths, which server.js will answer
// specifically in Step 2.
//
// PORT 53 NOTE:
// DNS conventionally runs on UDP port 53, which is a privileged
// port on most OSes:
//   - Windows: usually fine without special privileges, but some
//     setups need "Run as Administrator" for the terminal.
//   - macOS/Linux: needs sudo, OR set DNS_PORT to something >1024
//     in .env and forward/port-map it another way. For a first
//     test, just try it normally -- if you see an EACCES /
//     permission error in the console, that's this issue.
// ============================================================

const dns2 = require("dns2");
const { Packet } = dns2;

// Domains each OS uses to detect whether a network requires
// sign-in. Matched by exact hostname OR "ends with" for
// subdomains (e.g. Android sometimes queries variations under
// gstatic.com).
const CAPTIVE_PROBE_DOMAINS = [
  "captive.apple.com", // iOS / macOS
  "www.apple.com", // some iOS versions also check this
  "connectivitycheck.gstatic.com", // Android
  "connectivitycheck.android.com", // Android (older)
  "clients3.google.com", // Android (some OEM builds)
  "msftconnecttest.com", // Windows
  "www.msftconnecttest.com", // Windows
  "msftncsi.com", // older Windows
  "www.msftncsi.com",
];

function isCaptiveProbeDomain(name) {
  const lower = name.toLowerCase();
  return CAPTIVE_PROBE_DOMAINS.some(
    (domain) => lower === domain || lower.endsWith(`.${domain}`)
  );
}

/**
 * Starts the local DNS server.
 * @param {string} localIP - The LAN IP every domain should resolve to
 *   (reuses the same IP-detection logic already in server.js).
 * @param {number} port - UDP port to listen on (default 53).
 * @returns {dns2.UDPServer} the running server instance, so callers
 *   can attach error handlers or close it later if needed.
 */
function startDnsServer(localIP, port = 53) {
  const server = dns2.createServer({
    udp: true,
    handle: (request, send) => {
      const response = Packet.createResponseFromRequest(request);
      const [question] = request.questions;
      const { name } = question;

      // Every A-record query gets answered with our own IP.
      // This is intentional (see file header) -- both known
      // captive-probe domains AND everything else resolve here,
      // since there is no real internet DNS to fall back to.
      response.answers.push({
        name,
        type: Packet.TYPE.A,
        class: Packet.CLASS.IN,
        ttl: 5, // short TTL: phones re-check often, keep it fresh
        address: localIP,
      });

      if (isCaptiveProbeDomain(name)) {
        console.log(`[dns] captive-probe domain requested: ${name} -> ${localIP}`);
      }

      send(response);
    },
  });

  server.on("requestError", (error) => {
    console.error("[dns] request error:", error);
  });

  server.listen({ udp: { port, address: "0.0.0.0" } });

  server.on("listening", () => {
    console.log(`[dns] Local DNS server listening on UDP port ${port}`);
    console.log(`[dns] All domains will resolve to ${localIP}`);
  });

  return server;
}

module.exports = { startDnsServer, isCaptiveProbeDomain, CAPTIVE_PROBE_DOMAINS };