# Security policy

Scam Sentinel is a proof of concept. It is not hardened for production and should not be fed real customer data.

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's **Report a vulnerability** button on the repository's Security tab (private vulnerability reporting). Include steps to reproduce and the affected file or commit. You should get a reply within 7 days.

## Scope

In scope:

- Script injection through imported CSV / JSON corpus files or signature libraries.
- Path traversal or exposure beyond the project folder in `tools/serve.js`.
- Anything in `tools/` that writes outside the paths it is given.

Out of scope:

- Model accuracy or evasion of the classifier. This is a research demo; please open a normal issue or discussion.
- Issues that require a compromised CDN. TensorFlow.js is loaded from cdnjs at a pinned version; adding Subresource Integrity is a known open item.

## Notes for operators

- `tools/serve.js` binds to `127.0.0.1` only and serves the project folder read-only. Do not expose it to a network.
- The page runs entirely in the browser and sends no data anywhere, but files you import still live on your machine; handle them under your own data policy.
