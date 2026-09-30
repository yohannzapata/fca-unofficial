# Security policy

## Reporting a vulnerability

Please report security issues privately through GitHub:
**Security → Report a vulnerability** on this repository. Do not open a public issue.

**Never include session material** (cookies such as `xs` or `c_user`, `appstate` files,
tokens, or passwords) in any report, issue, or log you share. The probe report from
`node tools/probe.ts` contains no secrets and is safe to attach.

## Scope and design

The library's threat model, network destinations, secret handling and dependency policy
are documented in [docs/security.md](docs/security.md).

## Supported versions

This project is in early development (0.x). Only the latest commit on `main` receives
fixes.
