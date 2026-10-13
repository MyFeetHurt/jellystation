#!/bin/sh
# Builds the demo MP4 (1080p30) and GIF from a recording directory (frames.txt from rec.py).
#   make_video.sh REC_DIR OUT_DIR
set -eu
rec=$1 out=$2
mkdir -p "$out"
ffmpeg -v error -y -f concat -safe 0 -i "$rec/frames.txt" -vf "fps=30,scale=1920:1080:flags=lanczos,format=yuv420p" \
  -c:v libx264 -preset slow -crf 22 -movflags +faststart "$out/jellystation-demo.mp4"
ffmpeg -v error -y -i "$out/jellystation-demo.mp4" -vf "fps=4,scale=640:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle" \
  "$out/demo.gif"
ls -la "$out"
