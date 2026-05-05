# Security Policy

Emily AgentOS is a local-first agent runtime with file, network, browser, GitHub, and provider integrations. Security reports are welcome and should be handled privately until a fix or mitigation is available.

## Supported Versions

Active security fixes target the current `dev` branch first, then the stable install branch when applicable.

| Branch | Supported |
| --- | --- |
| `dev` | Yes, active development and fixes |
| `master` | Yes, stable install branch |
| Older commits or forks | Best effort |

## Reporting a Vulnerability

Please do not open a public issue for a suspected vulnerability.

Preferred reporting channels:

1. Use GitHub private vulnerability reporting if it is enabled for the repository.
2. Otherwise, contact the maintainers privately through the repository owner's GitHub profile or another trusted private channel.

Include as much of the following as you can:

- affected branch or commit;
- runtime mode used (`tui`, `web`, `cron`, or direct CLI);
- relevant environment variables, with secrets redacted;
- steps to reproduce;
- expected and actual behavior;
- impact assessment;
- logs or screenshots with tokens, API keys, and personal data removed.

## Scope

Security-sensitive areas include:

- Web/API/Gateway authentication and token scope checks;
- origin checks and unsafe HTTP methods;
- provider configuration and secret handling;
- workspace path resolution and symlink handling;
- network egress controls and SSRF protections;
- tool approval enforcement;
- GitHub, browser, and destructive workspace actions;
- role permission clamping and subagent tool requests;
- persistence migrations that could corrupt or expose local state.

Out of scope for private security handling:

- missing features;
- unsupported local modifications;
- reports requiring access to secrets that were already leaked outside the project;
- denial-of-service scenarios that require full local machine control.

## Disclosure Process

Maintainers should acknowledge a report as soon as practical, investigate impact, prepare a fix, and coordinate disclosure timing with the reporter. Public disclosure should wait until users have a reasonable path to update or mitigate.

## Security Checks

Before exposing Emily AgentOS beyond loopback, run:

```bash
npm run check
node src/index.ts --doctor --deep
node src/index.ts --security-audit
```

Use strong tokens, keep `EMILY_HTTP_ALLOW_PRIVATE` unset in production, and prefer read/write scoped web tokens over sharing the admin token.
