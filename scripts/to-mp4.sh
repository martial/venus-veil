#!/bin/sh
# Convert a recorded clip to H.264 MP4 (only needed for older WebM recordings).
#   npm run to-mp4 -- ~/Downloads/venus-veil-limestone-....webm
set -e
[ -n "$1" ] || { echo "usage: npm run to-mp4 -- <clip.webm> [out.mp4]"; exit 1; }
input="$1"
output="${2:-${input%.*}.mp4}"
ffmpeg -y -i "$input" -c:v libx264 -preset slow -crf 16 -pix_fmt yuv420p -movflags +faststart "$output"
echo "wrote $output"
