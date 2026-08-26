# Private HTTPS sharing security acceptance criteria

These criteria apply to temporary, browser-only private sharing through an
exact Cloudflare Quick Tunnel HTTPS origin. They do not authorize a public
listener, public database, or unauthenticated media URL.

1. **Loopback remains the boundary.** With no sharing configuration, the only
   app origin is `http://127.0.0.1:3000`. Development and production servers
   bind to `127.0.0.1`, including while a tunnel is in use.
2. **Remote access is an explicit, exact opt-in.** It requires both
   `RIFF_REMOTE_ACCESS=1` and one canonical, non-loopback HTTPS `APP_ORIGIN`.
   Paths, queries, fragments, credentials, wildcards, plain HTTP, partial
   configuration, and unknown flag values fail closed. Comparisons cover the
   full scheme, hostname, and port; the default loopback origin remains usable.
3. **First setup cannot be claimed remotely.** The setup mutation accepts only
   a loopback browser `Origin` and rejects a tunnel origin before password work
   or any database access. Operationally, a tunnel is not exposed until the
   sole local account has been configured.
4. **Every mutation is same-origin.** `POST`, `PUT`, `PATCH`, and `DELETE`
   handlers require a non-empty browser `Origin` that exactly matches the local
   or explicitly configured remote allowlist. A missing, opaque, malformed, or
   lookalike origin receives `403`.
5. **Remote session cookies are HTTPS-only.** Session issue, replacement, and
   deletion use `HttpOnly`, `SameSite=Strict`, host-only path `/` cookies.
   `Secure` is derived from the already validated request `Origin`: true for
   the allowed HTTPS tunnel and false for direct loopback HTTP. Forwarded
   protocol headers alone cannot influence this decision.
6. **PostgreSQL stays local.** Application and maintenance database URLs accept
   PostgreSQL only on `127.0.0.1`, `localhost`, or `::1`; sharing configuration
   does not change this allowlist.
7. **Audio remains authenticated and non-cacheable.** Take and track audio
   routes authenticate before metadata or path lookup. Successful full/range
   responses, range errors, authentication failures, and other API errors use
   `no-store` (successful audio additionally uses `private`).

Run the no-service security checks with:

```sh
node --disable-warning=ExperimentalWarning --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test --experimental-strip-types lib/app-origin.test.ts
node --test scripts/private-sharing-security.test.mjs
```
