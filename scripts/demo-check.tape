# docs/demo/hunch-check.mp4 — a whole-file review against a published rule pack,
# recorded from a real run against ../Sovran/sovran-app.
#
#   vhs scripts/demo-check.tape
#   ffmpeg -y -i docs/demo/raw-check.mp4 -filter_complex \
#     "[0:v]trim=0:47.6,setpts=(PTS-STARTPTS)/2.4,fps=60[a];[0:v]trim=47.6:51.6,setpts=PTS-STARTPTS,fps=60[b];[a][b]concat=n=2:v=1[o]" \
#     -map "[o]" -c:v libx264 -pix_fmt yuv420p -crf 20 -movflags +faststart docs/demo/hunch-check.mp4
#
# The review runs at 2.4x and the report is held at 1x. 497 hunks take about 44 real
# seconds at the project's concurrency of 16; the bar and the estimate still read.
#
# No scroll-back tape here, unlike scripts/demo.tape: a clean review is 29 lines and
# fits one screen, so there is nothing to page through. If a future run does raise
# concerns, borrow scripts/demo-scroll.tape and cut the two parts together the same way.
#
# `--only "bip321/*"` picks the seven BIP-321 rules the project installed from the
# bips-spec pack; `--all` reviews whole files rather than a diff, which is what makes
# this a question about the code as it stands rather than about a change. The paths are
# where a bitcoin: URI is parsed and where something acts on one — narrowing a review to
# the subsystem a rule is about is ordinary, unlike narrowing a search.
#
# Needs vhs 0.11.0, NOT 0.12.0 (charmbracelet/vhs#787), and `@latest` because plain npx
# served a cached 0.20.0 in that checkout. See scripts/demo.tape for both, and for why
# the capture goes through script(1) instead of a pipe.

Output "docs/demo/raw-check.mp4"

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

Hide
Type "clear" Enter
Type "source scripts/demo-setup.sh" Enter
Type "cd ../Sovran/sovran-app" Enter
Sleep 500ms
Type "clear" Enter
Show
Sleep 1s
# Split across Type commands so the glob's quotes survive the tape parser.
Type@20ms 'npx -y --min-release-age=0 @kelbie/hunch@latest check --all '
Type@20ms 'wallet/src app/features/send app/features/receive app/features/contacts '
Type@20ms '--only "bip321/*" --code'
Sleep 1s
Enter
Sleep 150s
