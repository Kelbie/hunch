# Sourced, hidden, by scripts/demo.tape before the take. Nothing here is part of using
# Hunch — it exists so the recording can capture the report for the scroll-back without
# putting a pipe on screen.
#
# script(1) keeps a real pty, so the command inside it still sees a terminal: Hunch picks
# its own reporter, its own colour and the full terminal width, exactly as it would if
# nobody were recording. A `| tee` cannot do that — it makes stdout a pipe, which flips
# the reporter to markdown, drops the colour and falls back to an 80-column layout.
#
# No recursion: script execs npx directly rather than through a shell, so the function
# below does not call itself.
npx() { script -q /tmp/hunch-find.ansi npx "$@"; }

# The capture holds every frame the live region drew, and npx's own package-resolution
# spinner before it. Replayed through a pager both are noise.
#
# They redraw differently, so they need separate rules. The region brackets itself with
# hide-cursor and show-cursor, which marks exactly the bytes to drop. npx instead rewrites
# its line in place with column-one-and-erase, so for those the surviving text is whatever
# follows the last erase on that line.
strip_live() {
  perl -0pe 's/\e\[\?25l.*?\e\[\?25h//gs; s/^.*\e\[1G\e\[0K//mg' "$1" > "$2"
}
