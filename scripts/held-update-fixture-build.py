#!/usr/bin/env python3
"""Builds the held-update CI fixture: a disposable git repo with four contiguous first-parent commits (real fixture-version
file 0..3, refs/remotes/origin/main at commit 3) and four REAL derived images (FROM the exact built app base digest, COPY the
fixture file, LABEL revision = fixture commit). Every COPY changes bytes, so digests differ: no retag, no fabricated digest.
Needs `docker login ghcr.io` done by the workflow. Output: fixture.json {repo, images:[{sha,digest} x4]}. Bounded, no secrets."""
import argparse, json, os, re, subprocess, sys, tempfile
from pathlib import Path

def run(*a, cwd=None):
    r = subprocess.run(a, cwd=cwd, text=True, capture_output=True, timeout=1800)
    if r.returncode: raise RuntimeError('fixture-build-command-failed: ' + a[0] + ' ' + a[1])
    return r.stdout.strip()

def main():
    p = argparse.ArgumentParser(); p.add_argument('--base', required=True); p.add_argument('--repo', required=True); p.add_argument('--out', required=True); p.add_argument('--tag-prefix', required=True)
    a = p.parse_args()
    if not re.fullmatch(r'ghcr\.io/manudss/iam-platform-poc@sha256:[0-9a-f]{64}', a.base): raise ValueError('exact base digest required')
    if not re.fullmatch(r'held-fixture-[0-9]+-[0-9]+', a.tag_prefix): raise ValueError('isolated run/attempt tag prefix required')
    repo = Path(a.repo)
    if repo.exists(): raise ValueError('fresh repo path required')
    repo.mkdir(parents=True); env = {'GIT_AUTHOR_NAME': 'ci', 'GIT_AUTHOR_EMAIL': 'ci@example.invalid', 'GIT_COMMITTER_NAME': 'ci', 'GIT_COMMITTER_EMAIL': 'ci@example.invalid'}
    os.environ.update(env); run('git', 'init', '-q', '-b', 'main', str(repo))
    shas = []
    for i in range(4):
        (repo / 'fixture-version').write_text('fixture version %d\n' % i)
        run('git', 'add', 'fixture-version', cwd=repo); run('git', 'commit', '-q', '-m', 'fixture %d' % i, cwd=repo); shas.append(run('git', 'rev-parse', 'HEAD', cwd=repo))
    run('git', 'update-ref', 'refs/remotes/origin/main', shas[-1], cwd=repo)
    images = []
    for i, sha in enumerate(shas):
        ctx = Path(tempfile.mkdtemp(prefix='held-fixture-ctx-')); (ctx / 'fixture-version').write_text('fixture version %d\n' % i)
        (ctx / 'Dockerfile').write_text('FROM %s\nCOPY fixture-version /app/held-fixture-version\nLABEL org.opencontainers.image.revision=%s\n' % (a.base, sha))
        tag = 'ghcr.io/manudss/iam-platform-poc:%s-%d' % (a.tag_prefix, i); meta = ctx / 'meta.json'
        run('docker', 'buildx', 'build', '--push', '--metadata-file', str(meta), '-t', tag, str(ctx))
        digest = json.loads(meta.read_text())['containerimage.digest']
        ref = 'ghcr.io/manudss/iam-platform-poc@' + digest
        run('docker', 'pull', ref); label = json.loads(run('docker', 'image', 'inspect', ref))[0]['Config']['Labels']['org.opencontainers.image.revision']
        if label != sha: raise RuntimeError('fixture-label-mismatch')
        images.append({'sha': sha, 'digest': digest})
    if len({i['digest'] for i in images}) != 4: raise RuntimeError('fixture-digests-not-distinct')
    Path(a.out).write_text(json.dumps({'repo': str(repo), 'images': images}, indent=2))
if __name__ == '__main__': main()
