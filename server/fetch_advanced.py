"""Download only the weights needed by optional engines; never accept gated terms automatically."""
import argparse
import json
import shutil
from advanced_models import CACHE, ENGINES


def install(name):
    from huggingface_hub import HfApi, snapshot_download
    CACHE.mkdir(parents=True, exist_ok=True)
    api = HfApi()
    paths = {}
    import fnmatch
    for repo, patterns in ENGINES[name]['repos']:
        info = api.model_info(repo, files_metadata=True)
        files = [item for item in info.siblings if any(fnmatch.fnmatch(item.rfilename, pattern) for pattern in patterns)]
        needed = sum(item.size or 0 for item in files)
        # Cached blobs do not consume space twice; estimate only missing files.
        try:
            old = snapshot_download(repo, cache_dir=CACHE, local_files_only=True)
            from pathlib import Path
            needed = sum(item.size or 0 for item in files if not (Path(old) / item.rfilename).exists())
        except Exception:
            pass
        free = shutil.disk_usage(CACHE).free
        if needed + 1024 ** 3 > free:
            raise RuntimeError(f'Not enough disk for {repo}: need {needed / 1e9:.1f} GB plus 1 GB reserve, have {free / 1e9:.1f} GB.')
        print(f'{name}: downloading {repo} ({needed / 1e9:.1f} GB uncached)', flush=True)
        paths[repo] = snapshot_download(repo, cache_dir=CACHE, allow_patterns=patterns, max_workers=2)
    (CACHE / f'{name}.ready.json').write_text(json.dumps(paths))
    print(f'{name}: installed', flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('engines', nargs='+', choices=list(ENGINES))
    for name in parser.parse_args().engines:
        install(name)
