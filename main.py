#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
递归替换指定目录下所有文件名、文件夹名以及文本文件内容中的字符串。

替换规则（按顺序执行）：
    kamubaba-i -> Skrepy0
    KAMUCL     -> FAIONYX
    Kamucl     -> Faionyx
    kamucl     -> faionyx

用法：
    python main.py <目录>            # 实际执行
    python main.py <目录> --dry-run  # 只预览，不改动
"""

import argparse
import os
import sys

REPLACEMENTS = [
    ("kamubaba-i", "Skrepy0"),
    ("KAMUCL", "FAIONYX"),
    ("Kamucl", "Faionyx"),
    ("kamucl", "faionyx"),
]

# 依次尝试的文本编码
ENCODINGS = ("utf-8", "gbk")


def replace_text(text: str) -> str:
    """对字符串应用全部替换规则。"""
    for old, new in REPLACEMENTS:
        text = text.replace(old, new)
    return text


def process_file_content(path: str, dry_run: bool) -> bool:
    """替换单个文件的内容。返回是否发生了改动。

    二进制文件或无法解码的文件会被跳过。
    """
    try:
        with open(path, "rb") as f:
            raw = f.read()
    except OSError as e:
        print(f"[跳过] 无法读取: {path} ({e})")
        return False

    if not raw:
        return False

    # 含 NUL 字节基本可判定为二进制文件
    if b"\x00" in raw:
        return False

    for enc in ENCODINGS:
        try:
            text = raw.decode(enc)
        except UnicodeDecodeError:
            continue

        new_text = replace_text(text)
        if new_text == text:
            return False  # 解码成功但内容无变化

        print(f"[内容] {path}  (编码: {enc})")
        if not dry_run:
            try:
                with open(path, "wb") as f:
                    f.write(new_text.encode(enc))
            except OSError as e:
                print(f"[错误] 写入失败: {path} ({e})")
                return False
        return True

    return False  # 所有编码都解不开，视为二进制，跳过


def collect_entries(root: str):
    """收集 root 下所有文件和文件夹的路径（不含 root 自身）。"""
    entries = []
    for dirpath, dirnames, filenames in os.walk(root):
        for name in filenames:
            entries.append(os.path.join(dirpath, name))
        for name in dirnames:
            entries.append(os.path.join(dirpath, name))
    return entries


def main():
    parser = argparse.ArgumentParser(
        description="递归替换目录下文件名、文件夹名及文件内容中的指定字符串"
    )
    parser.add_argument("directory", help="要处理的目录")
    parser.add_argument(
        "--dry-run", action="store_true", help="只显示将要做的修改，不实际写入"
    )
    args = parser.parse_args()

    root = os.path.abspath(args.directory)
    if not os.path.isdir(root):
        print(f"错误：{root} 不是一个有效目录")
        sys.exit(1)

    if args.dry_run:
        print("=== 试运行模式（不会修改任何文件） ===\n")

    # ---------- 第一步：替换文件内容 ----------
    print(">>> 替换文件内容 ...")
    changed = 0
    for dirpath, _dirnames, filenames in os.walk(root):
        for name in filenames:
            full = os.path.join(dirpath, name)
            if os.path.islink(full):
                continue
            if process_file_content(full, args.dry_run):
                changed += 1
    print(f"    内容替换完成，共 {changed} 个文件被修改\n")

    # ---------- 第二步：重命名文件与文件夹 ----------
    print(">>> 重命名文件 / 文件夹 ...")
    entries = collect_entries(root)
    # 按路径深度从深到浅排序：先改文件，再改上层目录，避免路径失效
    entries.sort(key=lambda p: p.count(os.sep), reverse=True)

    renamed = 0
    for path in entries:
        if not os.path.exists(path):
            continue
        dirname, basename = os.path.split(path)
        new_basename = replace_text(basename)
        if new_basename == basename:
            continue

        new_path = os.path.join(dirname, new_basename)
        if os.path.exists(new_path):
            print(f"[跳过] 目标已存在: {path}  ->  {new_path}")
            continue

        print(f"[重命名] {path}  ->  {new_path}")
        if not args.dry_run:
            try:
                os.rename(path, new_path)
            except OSError as e:
                print(f"[错误] 重命名失败: {path} ({e})")
                continue
        renamed += 1

    print(f"    重命名完成，共 {renamed} 项")
    print("\n全部完成。" + ("（试运行，未做任何实际改动）" if args.dry_run else ""))


if __name__ == "__main__":
    main()