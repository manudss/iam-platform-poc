"""Exact immutable baseline identity. No network, tags, or deployment effects."""
import re
import subprocess


def current_parent(repository):
    return subprocess.check_output(['git', '-C', str(repository), 'rev-parse', 'HEAD^1'], text=True).strip()


def verify_baseline(repository, label_sha, built_sha):
    if not re.fullmatch('[a-f0-9]{40}', label_sha or '') or label_sha != built_sha:
        raise ValueError('baseline-source-label-invalid')
    if current_parent(repository) != label_sha:
        raise ValueError('baseline-is-not-current-first-parent')
    return label_sha
