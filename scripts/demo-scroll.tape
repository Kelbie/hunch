# The scroll-back half of scripts/demo.tape. Reads the report that tape saved, so it
# calls nothing and costs nothing: re-run it freely until the scrolling looks right.
#
# `Up@26ms 365` scrolls a line at a time, about thirty lines a second: paging with `b`
# jumps a screen at once and reads as a cut, not a scroll. 300 lines is the whole report
# plus slack, and less stops at the top, so the last frame is the headline. Recount it
# when the report gets longer — `wc -l /tmp/hunch-find-clean.ansi`.

Output "docs/demo/raw-scroll.mp4"

Set Width 1420
Set Height 800
Set FontSize 15
Set Framerate 60
Set Padding 18
Set Margin 40
Set MarginFill "#0f1116"
Set BorderRadius 10
Set WindowBar Colorful
Set Theme { "background": "#171a21", "foreground": "#d6dae3", "cursor": "#d6dae3", "selection": "#21242c", "black": "#0f1116", "red": "#ff6b6b", "green": "#79d17a", "yellow": "#e7c26a", "blue": "#7aa2f7", "magenta": "#c58af9", "cyan": "#5fc9d4", "white": "#d6dae3", "brightBlack": "#7e8795", "brightRed": "#ff6b6b", "brightGreen": "#79d17a", "brightYellow": "#e7c26a", "brightBlue": "#7aa2f7", "brightMagenta": "#c58af9", "brightCyan": "#5fc9d4", "brightWhite": "#e8ecf2" }

# Hidden until less has painted, so the join with the first part shows no second prompt.
Hide
Type "clear" Enter
Sleep 300ms
Type "source scripts/demo-setup.sh; strip_live /tmp/hunch-find.ansi /tmp/hunch-find-clean.ansi" Enter
Sleep 800ms
Type "clear" Enter
Type "less -R +G /tmp/hunch-find-clean.ansi" Enter
Sleep 1500ms
Show
Sleep 300ms
Up@26ms 365
Sleep 2500ms
