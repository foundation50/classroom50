#!/bin/zsh
# Drives gh's zsh completer against the fake gh on PATH. HARNESS_LOAD picks
# how gh's completer is available: "fpath" (Homebrew layout: a lazy autoload
# stub in fpath) or "none" (the wrapper must generate it). Output: one
# "<case>\t<completion words>" line per case, for the Go test to assert on.
set -e
mkdir -p "$HARNESS_TMP/fpath"
if [[ "$HARNESS_LOAD" == "fpath" ]]; then
    gh completion -s zsh > "$HARNESS_TMP/fpath/_gh"
fi
# Keep the system function dirs (compinit lives there) but drop any
# site-functions so a real installed _gh cannot leak into the run.
fpath=("$HARNESS_TMP/fpath" ${fpath:#*site-functions*})
autoload -Uz compinit && compinit -u -D

for f in "$@"; do
    # A user's rc that re-runs gh's own `eval "$(gh completion -s zsh)"`
    # between two loads of the same script.
    if [[ "$f" == --reload-gh ]]; then eval "$(gh completion -s zsh)"; else source "$f"; fi
done

# Stubs for the compsys calls the completer makes. _describe receives an
# array of "name:description" entries; keep the names only.
_describe() {
    local -a arr; arr=("${(@P)2}")
    local c; for c in "${arr[@]}"; do printf '%s ' "${c%%:*}"; done
    return 0
}
compadd() { :; }
_arguments() { printf '<files> '; }

run() {
    local id=$1; shift
    words=("$@"); CURRENT=${#words}
    printf '%s\t' "$id"
    _gh || true
    printf '\n'
}

run student_root gh student ""
run student_prefix gh student sub
run student_flags gh student accept --
run teacher_group gh teacher assignment ""
run gh_own gh pr ch
run gh_ext_name gh stu
