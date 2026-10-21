# Privacy and local data

MaiBadges stores role fields, duties, avatar files, explicit title bindings, card position and display preferences in the selected local state directory. The default is `~/Library/Application Support/MaiBadges`. State includes a SQLite database, assets, configuration and diagnostic files.

The project does not operate a cloud storage service, telemetry endpoint, advertising system or payment service. The local MCP server communicates with its host over stdio. This does not mean that everything stays outside the host's services: structured role data returned by tools can be included in the host's chat context and processed under that host's own settings and policies. Image data supplied to an app view is also available to its host environment. Do not put secrets in role descriptions or duties.

When explicitly enabled, the optional loader connects only to a configured loopback CDP endpoint. Its normal context matching uses target metadata and the complete window/document title, not chat message bodies. It sends the badge display data needed to render the chosen role into the registered page. A CDP endpoint itself has broader debugging powers; the project's limited behavior does not reduce the endpoint's general authority.

In-memory image and card caches are bounded and belong to the running session. Cache contents are not a cloud backup or permanent photo store. Persistent role data remains in the local state directory until the user removes it. Stopping or uninstalling the plugin preserves that directory; follow [INSTALL.md](INSTALL.md) to disable the loader and remove owned entries first.

Diagnostics may contain paths, target titles, timestamps and error details. Review and redact them before sharing. There is no automatic deletion schedule or remote erasure service. To delete local data, first stop all users of the selected state directory, back up anything you need, then remove only the directory you have verified.
