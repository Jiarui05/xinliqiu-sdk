#!/usr/bin/env python3
"""Publish only committed backend source to the auto-deploy branch, without exposing device research history."""
import subprocess


def git(*args):
    """Run Git with the operator's configured authentication and fail on concurrent push conflicts."""
    return subprocess.check_output(["git", *args], text=True).strip()


def main():
    """Create a backend-only commit with the last deployed source as parent, then push normally."""
    root = git("rev-parse", "--show-toplevel")
    import os
    os.chdir(root)
    if git("status", "--porcelain", "--", "backend"):
        raise SystemExit("Commit backend changes before publishing")
    branch = "deploy/transcript-service"
    tree = git("rev-parse", "HEAD:backend")
    remote = git("ls-remote", "--heads", "origin", "refs/heads/" + branch)
    parent = []
    if remote:
        git("fetch", "origin", "refs/heads/" + branch)
        previous = git("rev-parse", "FETCH_HEAD")
        if git("rev-parse", previous + "^{tree}") == tree:
            print("Cloud branch already matches the committed backend")
            return
        parent = ["-p", previous]
    commit = git("commit-tree", tree, *parent, "-m", "Deploy backend " + git("rev-parse", "--short", "HEAD"))
    subprocess.run(["git", "push", "origin", commit + ":refs/heads/" + branch], check=True)
    print("Published " + commit + "; verify the Dokploy deployment and HTTPS release manifest")


if __name__ == "__main__":
    main()
