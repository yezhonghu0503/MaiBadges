# Contributing

Issues and pull requests are welcome. Prefer a small change with a clear problem, resulting behavior, and validation. For a broad feature or a change to the permission model, discuss the design before implementation.

## Local development

Requirements: Python 3.9+, Node.js 20+, and macOS for desktop loader or launch-service checks.

```sh
python3 build_package.py
python3 validate.py
python3 build_package.py --archive
```

Use only generic sample data in tests, screenshots and recordings. Keep databases, local MCP configuration, credentials, chat titles, logs and personal art out of commits and release archives. Building does not authorize starting an application, connecting to CDP or installing a login item.

Preserve the separation between the management plugin and optional loader. Do not add external telemetry, silently enroll windows, broaden network listeners, reuse another role's material, or bypass a host policy rejection. Keep reduced-motion, keyboard access, readable text, long content and bounded cache behavior in mind.

Retain MIT notices for adapted code and the font's OFL notice. Submitted code and original demo assets should be compatible with the project's MIT license. New third-party components require their source and license in THIRD_PARTY_NOTICES.md. Do not submit upstream sample artwork or personal team assets.

For UI changes, attach a screenshot of the actual shared renderer or manager using public data, and say which interactions you checked. For security reports, follow [SECURITY.md](SECURITY.md) instead of posting sensitive details in an issue.
