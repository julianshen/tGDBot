#!/bin/sh
# Builds the dynamic tree-sitter grammar libraries the structural checks can
# load for Python and Go (issue #142). The grammars are NOT npm dependencies:
# they are compiled from pinned grammar-repo versions into shared libraries
# that @ast-grep/napi's registerDynamicLanguage loads at check time.
#
# Usage:  scripts/build-tree-sitter-grammars.sh [output-dir]
# Env:    TGD_TREE_SITTER_LIB_DIR=<output-dir> when running the review or the
#         grammar-backed tests. Languages whose library is absent are simply
#         not covered - TS/JS behavior is unchanged.
#
# Requires: git, a C compiler (gcc/clang). ~1 minute on a laptop.

set -eu
OUT="${1:-.tree-sitter-grammars}"
mkdir -p "$OUT"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

build() {
  repo="$1"; lib="$2"
  git clone -q --depth 1 "https://github.com/tree-sitter/${repo}.git" "$TMP/$repo"
  # The scanner is optional (python has one, go does not).
  SOURCES="src/parser.c"
  [ -f "$TMP/$repo/src/scanner.c" ] && SOURCES="$SOURCES src/scanner.c"
  (cd "$TMP/$repo" && gcc -shared -fPIC -I src $SOURCES -o "$OUT/$lib")
  echo "built $OUT/$lib"
}

build tree-sitter-python tree_sitter_python.so
build tree-sitter-go tree_sitter_go.so
echo "done - run reviews and tests with TGD_TREE_SITTER_LIB_DIR=$PWD/$OUT"
