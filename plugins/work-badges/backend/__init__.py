"""Local work-badge storage and MCP server; importing creates no state."""

from .registry import Registry, RegistryError, ValidationError, ConflictError

__all__ = ["Registry", "RegistryError", "ValidationError", "ConflictError"]
