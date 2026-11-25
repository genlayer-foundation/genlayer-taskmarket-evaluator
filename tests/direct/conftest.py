"""Shared helpers for direct mode tests."""


def to_hex(addr_bytes):
    """Convert address bytes to checksummed hex."""
    if hasattr(addr_bytes, "as_hex"):
        return addr_bytes.as_hex
    from genlayer.py.types import Address

    return Address(addr_bytes).as_hex


def model_reply(payload):
    """The direct host unwraps JSON once before the contract SDK parses the model text."""
    import json
    return json.dumps(json.dumps(payload))
