#!/usr/bin/env python3
"""
文件：publish-cloud.py
目的：检查并发布已提交的 server 子树，不携带用户数据。

职责与入口：
- Git 命令与身份复用 → git()。
- 发布检查、构造部署提交和正常推送 → main()。

边界：检查失败或推送冲突时停止，不强制覆盖远程分支。
"""
import subprocess
import os


def git(*args):
    """使用已配置的身份执行 Git；并发推送冲突时停止，不强制覆盖。"""
    return subprocess.check_output(["git", *args], text=True).strip()


def main():
    """检查源码与契约，再以上次部署为父提交发布 server 子树。"""
    root = git("rev-parse", "--show-toplevel")
    os.chdir(root)
    remote_name = os.environ.get("XQ_DEPLOY_REMOTE", "cloud")
    if git("status", "--porcelain", "--", "server"):
        raise SystemExit("Commit server changes before publishing")
    subprocess.run(["pnpm", "--dir", "server", "check"], check=True)
    if git("status", "--porcelain", "--", "server"):
        raise SystemExit("Release checks changed server files; commit before publishing")
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
