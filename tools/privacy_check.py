"""Conservative release checks; never a substitute for a human staged-diff review."""
import argparse
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PATTERNS = {
    "private-key": re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    "github-token": re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,})\b"),
    "cloud-access-key": re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    "credential-url": re.compile(r"https?://[^\s/@]+:[^\s/@]+@"),
    "personal-machine-path": re.compile(r"(?:[A-Za-z]:[/\\]+Users[/\\]+(?!<)[A-Za-z0-9_-]+[/\\]|/home/[A-Za-z0-9_-]+/)"),
}
PRIVATE_PARTS = {"runtime", "private", ".venv", "node_modules", "__pycache__"}
PRIVATE_SUFFIXES = {".csv", ".db", ".sqlite", ".sqlite3", ".pem", ".key", ".p12", ".jsonl", ".log"}


def source_files():
    result = subprocess.run(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], cwd=ROOT, capture_output=True)
    if result.returncode == 0:
        return [ROOT / name for name in result.stdout.decode().split("\0") if name]
    # Source archives also support this check without a Git checkout.
    return [p for p in ROOT.rglob("*") if p.is_file() and not set(p.relative_to(ROOT).parts) & (PRIVATE_PARTS | {".git"})]


def inspect(path, denied=()):
    relative = path.relative_to(ROOT)
    if path.is_symlink() or set(relative.parts) & PRIVATE_PARTS or path.suffix in PRIVATE_SUFFIXES or path.name.startswith(".env"):
        return [(str(relative), 0, "private-runtime-or-secret-file")]
    if not path.is_file():
        return []
    try:
        data = path.read_text(encoding="utf-8")
    except UnicodeError:
        return [(str(relative), 0, "unreviewed-binary")]
    findings = []
    for number, line in enumerate(data.splitlines(), 1):
        if relative.parts[0] == "tests":
            # Explicit fake credentials exercise rejection on the reserved example domain.
            line = re.sub(r"https?://user:(?:password|secret)@example\.com\b", "REJECTED_SYNTHETIC_URL", line)
        for label, pattern in PATTERNS.items():
            if pattern.search(line):
                findings.append((str(relative), number, label))
        if any(term.casefold() in line.casefold() for term in denied):
            findings.append((str(relative), number, "denied-project-specific-text"))
    return findings


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--deny-text", action="append", default=[], help="Additional prior-client/project text to exclude; findings never echo content")
    args = parser.parse_args()
    paths = sorted(set(source_files()))
    findings = [finding for path in paths for finding in inspect(path, args.deny_text)]
    for path, line, kind in findings:
        print(f"{path}:{line}: {kind}")
    print(f"Release privacy check: {len(paths)} source files, {len(findings)} findings. Review staged diff as well.")
    return 1 if findings else 0


if __name__ == "__main__":
    raise SystemExit(main())
