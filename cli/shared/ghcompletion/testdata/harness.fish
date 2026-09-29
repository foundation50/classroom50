# Drives fish's real completion engine (complete -C) against the fake gh on
# PATH. HARNESS_LOAD picks how gh's completer is available: "autoload" (the
# vendor_completions.d layout, loaded lazily on first Tab) or "none" (the
# wrapper must generate it). Output: one "<case>\t<completion words>" line
# per case.
if test "$HARNESS_LOAD" = autoload
    mkdir -p $HARNESS_TMP/completions
    gh completion -s fish > $HARNESS_TMP/completions/gh.fish
    set -g fish_complete_path $HARNESS_TMP/completions
else
    set -g fish_complete_path
end

for f in $argv
    # A user re-sourcing gh's own completion file between two loads of the
    # same script.
    if test "$f" = --reload-gh
        gh completion -s fish | source
    else
        source $f
    end
end

function run
    set -l id $argv[1]
    set -l line $argv[2]
    # complete -C prints "word\tdescription"; keep the words.
    set -l words (complete -C "$line" | string replace -r '\t.*' '')
    printf '%s\t%s\n' $id "$words"
end

run student_root "gh student "
run student_prefix "gh student sub"
run student_flags "gh student accept --"
run teacher_group "gh teacher assignment "
run gh_own "gh pr ch"
run gh_ext_name "gh stu"
