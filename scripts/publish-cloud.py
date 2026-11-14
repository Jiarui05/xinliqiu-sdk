#!/usr/bin/env python3
"""Publish the committed server tree to the existing automatic deployment branch."""
import subprocess
import os


def git(*args):
    """Run Git with the operator's configured authentication and fail on concurrent push conflicts."""
    return subprocess.check_output(["git", *args], text=True).strip()


def main():
    """Create a server-only commit with the last deployed source as parent, then push normally."""
    root = git("rev-parse", "--show-toplevel")
    os.chdir(root)
    remote_name = os.environ.get("XQ_DEPLOY_REMOTE", "cloud")
    if git("status", "--porcelain", "--", "server"):
        raise SystemExit("Commit server changes before publishing")
    branch = "deploy/transcript-service"
    tree = git("rev-parse", "HEAD:server")
    remote = git("ls-remote", "--heads", remote_name, "refs/heads/" + branch)
    parent = []
    if remote:
        git("fetch", remote_name, "refs/heads/" + branch)
        previous = git("rev-parse", "FETCH_HEAD")
        if git("rev-parse", previous + "^{tree}") == tree:
            print("Cloud branch already matches the committed server")
            return
        parent = ["-p", previous]
    commit = git("commit-tree", tree, *parent, "-m", "Deploy server " + git("rev-parse", "--short", "HEAD"))
    subprocess.run(["git", "push", remote_name, commit + ":refs/heads/" + branch], check=True)
    print("Published " + commit + "; verify the Dokploy deployment and HTTPS release manifest")


if __name__ == "__main__":
    main()
