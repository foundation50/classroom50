#!/bin/bash
# Drives gh's bash completer against the fake gh on PATH. HARNESS_LOAD picks
# how gh's completer is available: "eager" (sourced up front, the
# bash_completion.d layout), "loader" (bash-completion v2's lazy
# _completion_loader), or "none" (the wrapper must generate it). Output: one
# "<case>\t<completion words>" line per case.

# Minimal stand-in for the bash-completion helper cobra's fallback path
# calls; macOS bash 3.2 ships without the package.
_get_comp_words_by_ref() {
    while [[ $1 == -* ]]; do shift 2; done
    cur=${COMP_WORDS[COMP_CWORD]}
    prev=${COMP_WORDS[COMP_CWORD-1]}
    words=("${COMP_WORDS[@]}")
    cword=$COMP_CWORD
}

case "$HARNESS_LOAD" in
    eager) eval "$(gh completion -s bash)" ;;
    loader) _completion_loader() { eval "$(gh completion -s bash)"; } ;;
    none) ;;
esac

for f in "$@"; do source "$f"; done

run() {
    local id=$1; shift
    COMP_WORDS=("$@"); COMP_CWORD=$(( $# - 1 ))
    COMP_LINE="$*"; COMP_POINT=${#COMP_LINE}
    COMPREPLY=()
    __start_gh
    printf '%s\t%s\n' "$id" "${COMPREPLY[*]}"
}

run student_root gh student ""
run student_prefix gh student sub
run student_flags gh student accept --
run teacher_group gh teacher assignment ""
run gh_own gh pr ch
run gh_ext_name gh stu
