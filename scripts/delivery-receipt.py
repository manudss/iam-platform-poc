"""Validate the actual closed updater wire format, independent of incident UI code."""
import re

HELPERS = {'launcher_sha256', 'preflight_sha256', 'implementation_sha256'}


def validate_actual_receipt(raw):
    fields = {}
    counts = {}
    for line in raw.decode('utf-8', errors='strict').splitlines():
        key, separator, value = line.partition('=')
        if not separator or not key:
            raise ValueError('malformed-closed-receipt')
        counts[key] = counts.get(key, 0) + 1
        if key in fields:
            if key not in HELPERS or counts[key] != 2 or fields[key] != value:
                raise ValueError('unexpected-closed-receipt-duplicate')
        else:
            fields[key] = value
        if key in HELPERS and not re.fullmatch('[a-f0-9]{64}', value):
            raise ValueError('invalid-helper-hash')
    # This contract tests the current real producer, not a normalized dict.
    if any(counts.get(key) != 2 for key in HELPERS):
        raise ValueError('actual-updater-helper-multiplicity-changed')
    if any(count != 1 for key, count in counts.items() if key not in HELPERS):
        raise ValueError('unexpected-closed-receipt-duplicate')
    return fields
