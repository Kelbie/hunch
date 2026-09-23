# docs/demo/hunch-find.mp4 — the live search region, recorded from a real run against
# ../Sovran/sovran-app.
#
# `@latest` is not decoration. Plain `npx -y @kelbie/hunch` served a cached 0.20.0 in
# that checkout — a version with no live region at all — and the first take recorded the
# wrong CLI. Check the version before spending a run on it.
#
#   vhs scripts/demo.tape            # the sweep; writes docs/demo/raw.mp4
#   vhs scripts/demo-scroll.tape     # the scroll-back; free, replays the saved report
#   ffmpeg -y -i docs/demo/raw.mp4 -i docs/demo/raw-scroll.mp4 -filter_complex \
#     "[0:v]trim=0:22.5,setpts=(PTS-STARTPTS)/1.8,fps=60[a];[1:v]trim=0:13.0,setpts=PTS-STARTPTS,fps=60[b];[a][b]concat=n=2:v=1[o]" \
#     -map "[o]" -c:v libx264 -pix_fmt yuv420p -crf 20 -movflags +faststart docs/demo/hunch-find.mp4
#
# The sweep runs at 1.8x and the scroll at 1x. 174 chunks take about 18 real seconds,
# which is watchable with only a nudge. Keep the scope near this size: an earlier cut
# swept 681 chunks, took 110 seconds and needed 7.5x, at which the estimate is a blur.
#
# The task is chosen for facet spread, not just plausibility. NFC in that app is real but
# Android-only and send-only, so `receive ... on iOS` has an obvious place to edit (the
# nfc lib), an existing solution to copy (nearPay's contactless flow, and the Android
# ambient hook), screens that would consume it, and NFC tests that would need updating.
# --min 0.3 because at the default 0.5 only edit and test ever win the argmax, and
# --lines 8 because the report is 1,700 lines at the default and 357 at this one.
#
# Cut the first part where the report lands, not where the tape stops sleeping: the
# Sleep below is sized for a slow run, so most of it is a still frame. Find the moment
# with a band of the screen that the cursor never touches, or the pause reads as a hang:
#
#   for t in $(seq 8 0.3 20); do
#     ffmpeg -loglevel error -i docs/demo/raw.mp4 -ss $t -frames:v 1 \
#       -vf crop=1300:90:60:600 -y /tmp/f.png && echo "$t $(md5 -q /tmp/f.png)"
#   done
#
# Hashing the whole frame does not work: the cursor blinks about once a second, so every
# sample differs and a thirteen-second still frame looks like continuous motion.
#
# The two parts are recorded separately so the scroll can be redone without paying for
# the sweep again: the second tape only reads the capture the first one saved. The join
# is invisible because less opens on the same bottom-of-report screen the terminal was
# already showing. Re-measure the 12.4s whenever the sweep gets faster or slower.
#
# Needs vhs 0.11.0, NOT 0.12.0: charmbracelet/vhs#787 makes 0.12 exit 0 and write
# nothing against ffmpeg 9.x. Grab the 0.11.0 release binary rather than brew.
#
# The theme is scripts/terminal-shot.mjs's palette, so the video and docs/images agree.
# Nothing but the command itself is on screen. scripts/demo-setup.sh, sourced hidden
# below, routes it through script(1), which captures the session for the scroll-back
# while keeping a real pty — so Hunch picks its own reporter, colour and width, and the
# typed line is exactly what someone would type. An on-screen `| tee` would have shown
# scaffolding and, worse, changed the output: a piped stdout drops to markdown, loses
# colour and lays the report out for 80 columns instead of the terminal's.
#
# less cannot go in the pipeline either: it takes the screen and would hide the live
# region, which is the thing being demonstrated. It runs afterwards, over the capture.

Output "docs/demo/raw.mp4"

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
# Split across Type commands so the query's double quotes survive the tape parser.
Type@20ms 'npx -y --min-release-age=0 @kelbie/hunch@latest find '
Type@20ms '"receive a payment over NFC on iOS"'
Type@20ms ' app/shared/lib/nfc app/features/receive app/features/wallet app/features/nearPay app/__tests__/nfc*.test.ts --min 0.3 --lines 8'
Sleep 1s
Enter
Sleep 70s
