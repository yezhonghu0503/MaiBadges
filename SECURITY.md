# Security policy

## Supported scope

The current public release is experimental. Security fixes are targeted at the latest public version; there is no guarantee that every host version or previous release is supported.

## Debugging permission

The management MCP plugin does not require a browser debugging endpoint. The optional floating loader does. It must be enrolled and started explicitly, and is restricted to a configured loopback endpoint, normally `127.0.0.1:9347`. Do not expose or forward that port. A local process able to reach CDP may have extensive access to the debugged application, beyond the title and badge operations this project normally performs.

Do not disable host security controls, bypass policy errors, modify the official application binary or accept untrusted loader changes to make the integration work. Keep your host and operating system updated. The loader's pause-on-error behavior is a reason to inspect the error, not to retry indefinitely.

Closing a badge hides it; it does not close the debug port. Disable the owned login item, stop the loader, then exit the debug session and use the ordinary application entry if you no longer want debugging enabled. Commands are in [INSTALL.md](INSTALL.md).

## Reporting a vulnerability

Do not post credentials, complete databases, private chat titles, personal portraits or exploit details in a public issue. Use GitHub's private vulnerability reporting if it is enabled for this repository. If no private channel is available, open an issue requesting a private contact without disclosing the vulnerability itself. Maintainer account: `yezhonghu0503`.

Include the MaiBadges version, operating system and host version, a minimal reproduction using generic data, and the expected versus observed boundary. Redact local paths and personal data from logs. No fixed response or patch timeline is promised.
