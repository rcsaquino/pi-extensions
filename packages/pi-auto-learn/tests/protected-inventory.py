"""Read-only fingerprint of an explicitly selected tree, never its values."""
import argparse
import hashlib
import os
from pathlib import Path
import json
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('root', type=Path, help='Explicit tree to fingerprint; no production default')
root = parser.parse_args().root
if not root.is_dir():
    parser.error('root must be an existing directory')
h = hashlib.sha256()
count = 0
for directory, dirs, files in os.walk(root, followlinks=False):
    dirs.sort()
    for name in sorted(files):
        p = Path(directory) / name
        rel = str(p.relative_to(root)).encode()
        h.update(rel + b'\0')
        if p.is_symlink():
            h.update(b'link\0' + os.readlink(p).encode())
        elif p.is_file():
            h.update(hashlib.sha256(p.read_bytes()).digest())
        count += 1
print(json.dumps({'file_count': count, 'tree_sha256': h.hexdigest()}))
