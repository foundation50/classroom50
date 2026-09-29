#!/bin/bash
# Drives gh's bash completer against the fake gh on PATH. HARNESS_LOAD picks
# how gh's completer is available: "eager" (sourced up front, the
# bash_completion.d layout), "loader" (bash-completion v2's lazy
# _completion_loader), "none" (the wrapper must generate it), or
# "none-nocomp" (no bash-completion at all, as on stock macOS: the wrapper
# must register nothing). Output: one "<case>\t<completion words>" line per
# case; none-nocomp prints a single "registered\t<yes|no>" line instead.

# Minimal stand-in for the bash-completion helper cobra's fallback path
# calls; macOS bash 3.2 ships without the package.
if [[ "$HARNESS_LOAD" != none-nocomp ]]; then
    _get_comp_words_by_ref() {
        while [[ $1 == -* ]]; do shift 2; done
        cur=${COMP_WORDS[COMP_CWORD]}
        prev=${COMP_WORDS[COMP_CWORD-1]}
        words=("${COMP_WORDS[@]}")
        cword=$COMP_CWORD
    }
fi

# bash 4+ has the compopt builtin, which cobra's completer calls for display
# hints (nospace, filenames) and which refuses to run outside a live
# completion. Those hints never change COMPREPLY, so a no-op is faithful.
compopt() { :; }

case "$HARNESS_LOAD" in
    eager) eval "$(gh completion -s bash)" ;;
    loader) _completion_loader() { eval "$(gh completion -s bash)"; } ;;
    none | none-nocomp) ;;
esac

for f in "$@"; do
    # A user's rc that re-runs gh's own `eval "$(gh completion -s bash)"`
    # between two loads of the same script.
    if [[ "$f" == --reload-gh ]]; then eval "$(gh completion -s bash)"; else source "$f"; fi
done

if [[ "$HARNESS_LOAD" == none-nocomp ]]; then
    if complete -p gh >/dev/null 2>&1 || declare -F __start_gh >/dev/null 2>&1; then
        printf 'registered\tyes\n'
    else
        printf 'registered\tno\n'
    fi
    exit 0
fi

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
